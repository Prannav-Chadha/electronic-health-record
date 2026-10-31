/**
 * Cloud Delta Sync (offline-first)
 *
 * Every local change is queued as a "delta" in IndexedDB. When a link is available the device:
 *   1. PUSHES its unsent deltas to the hub  (POST /api/sync)   - in small, checkpointed chunks
 *   2. PULLS everything other devices sent   (GET  /api/sync?since=<cursor>)
 *      and merges it through the CRDT engine (idempotent, conflict-aware).
 *
 * Offline = nothing is lost: deltas just stay queued until the next successful sync.
 * An interrupted sync resumes from the last acknowledged chunk / pull cursor.
 */

class WeakLinkSyncService {
  constructor(storage, crdtEngine, hlcService) {
    this.storage = storage;
    this.crdt = crdtEngine;
    this.hlc = hlcService;

    this.networkProfile = 'FAST';   // 'FAST' (online) | 'OFFLINE' (user-forced offline)
    this.isSyncing = false;
    this.abortCurrentSync = false;
    this.endpoint = '/api/sync';

    this.maxChunkDeltas = 10;
    this.maxChunkBytes = 1.5 * 1024 * 1024; // keep each request well below Vercel's 4.5 MB body limit

    this.pullCursor = parseInt(this._ls('ehr_pull_cursor') || '0', 10) || 0;
    this.lastCheckpointHlc = this._ls('ehr_last_checkpoint_hlc') || '0:0:INIT';

    this.metrics = {
      totalBytesSynced: parseInt(this._ls('ehr_metric_bytes') || '0', 10) || 0,
      lastSyncLatencyMs: 0,
      totalSyncsAttempted: 0,
      totalSyncsCompleted: 0,
      resumedSyncsCount: 0,
      conflictsDetected: 0,
      pushedTotal: 0,
      pulledTotal: 0,
      lastSyncAt: this._ls('ehr_last_sync_at') || '',
      lastStatus: 'never'
    };

    this._autoTimer = null;
    this._debounce = null;
  }

  // ---------- settings ----------
  _ls(k) { try { return localStorage.getItem(k); } catch { return null; } }
  _lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

  getClinicKey() { return this._ls('ehr_clinic_key') || ''; }
  setClinicKey(k) { this._lsSet('ehr_clinic_key', String(k || '').trim()); }

  setProfile(profile) { this.networkProfile = profile; }

  _headers() {
    return { 'Content-Type': 'application/json', 'x-clinic-key': this.getClinicKey() };
  }

  // ---------- health ----------
  async checkConnection() {
    try {
      const res = await fetch('/api/status', { headers: { 'x-clinic-key': this.getClinicKey() }, cache: 'no-store' });
      if (!res.ok) return { reachable: false, message: `Server answered ${res.status}` };
      const j = await res.json();
      return { reachable: true, ...j };
    } catch (e) {
      return { reachable: false, message: 'Cannot reach the cloud hub (offline or API not deployed).' };
    }
  }

  // ---------- auto sync ----------
  startAutoSync(intervalMs = 30000) {
    this.stopAutoSync();
    const run = () => this.triggerSync(null, { silent: true });
    this._onOnline = run;
    // Upload soon after a local save, so other devices see it quickly
    this._onDelta = () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(run, 2500);
    };
    this._autoTimer = setInterval(run, intervalMs);
    window.addEventListener('online', this._onOnline);
    window.addEventListener('ehr:delta-recorded', this._onDelta);
    this._firstTimer = setTimeout(run, 1500); // first sync shortly after load
  }

  stopAutoSync() {
    if (this._autoTimer) clearInterval(this._autoTimer);
    clearTimeout(this._debounce);
    clearTimeout(this._firstTimer);
    this._autoTimer = null;
    if (this._onOnline) window.removeEventListener('online', this._onOnline);
    if (this._onDelta) window.removeEventListener('ehr:delta-recorded', this._onDelta);
    this._onOnline = this._onDelta = null;
  }

  // ---------- main entry ----------
  async triggerSync(onProgress = null, opts = {}) {
    if (this.isSyncing) return { status: 'already_syncing', message: 'A sync is already running.' };
    if (this.networkProfile === 'OFFLINE') {
      return { status: 'offline', message: 'Clinic device is in Offline Mode. Switch link on to sync.' };
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { status: 'offline', message: 'No network connection. Changes are saved locally and will sync when you are back online.' };
    }
    this.isSyncing = true;
    this.abortCurrentSync = false;
    this.metrics.totalSyncsAttempted++;
    const startTime = performance.now();
    let pushed = 0, pulled = 0, bytes = 0, conflicts = 0;

    try {
      // ---------- 1. PUSH ----------
      const unsynced = (await this.storage.getUnsyncedDeltas())
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

      const chunks = this._makeChunks(unsynced);
      for (let i = 0; i < chunks.length; i++) {
        if (this.abortCurrentSync) return this._interrupted(i + 1, chunks.length, pushed, pulled);

        const chunk = chunks[i];
        const body = JSON.stringify({ deltas: chunk.map(d => this._wire(d)) });
        const res = await fetch(this.endpoint, { method: 'POST', headers: this._headers(), body });
        const err = await this._httpError(res);
        if (err) return this._finishWithError(err);

        const j = await res.json();
        const ackSet = new Set(j.ackedIds || []);
        const rejected = new Set((j.rejected || []).filter(Boolean));
        // Rejected deltas are malformed: acknowledge locally so they don't block the queue forever
        const toAck = chunk.map(d => d.deltaId).filter(id => ackSet.has(id) || rejected.has(id));
        await this.storage.markDeltasAcked(toAck);

        const last = chunk[chunk.length - 1];
        if (last && last.hlc) { this.lastCheckpointHlc = last.hlc; this._lsSet('ehr_last_checkpoint_hlc', last.hlc); }
        pushed += toAck.length;
        bytes += body.length;
        if (onProgress) onProgress({ phase: 'push', currentChunk: i + 1, totalChunks: chunks.length, percent: Math.round(((i + 1) / chunks.length) * 50), bytesTransferred: bytes });
      }

      // ---------- 2. PULL ----------
      let page = 0, more = true;
      while (more) {
        if (this.abortCurrentSync) return this._interrupted(page + 1, page + 1, pushed, pulled);

        const res = await fetch(`${this.endpoint}?since=${this.pullCursor}`, { headers: this._headers(), cache: 'no-store' });
        const err = await this._httpError(res);
        if (err) return this._finishWithError(err);

        const text = await res.text();
        bytes += text.length;
        const j = JSON.parse(text);
        page++;

        for (const d of j.deltas || []) {
          if (d.nodeId && d.nodeId === this.hlc.nodeId) continue; // our own echo
          const r = await this.crdt.applyDelta(d, true);   // throws on storage error -> cursor NOT advanced
          if (r && r.success && !r.duplicate) pulled++;
          if (r && r.conflict) conflicts++;
        }
        // Cursor only moves after the whole page has been applied (resumable)
        this.pullCursor = j.cursor;
        this._lsSet('ehr_pull_cursor', String(this.pullCursor));
        more = !!j.hasMore;

        if (onProgress) onProgress({ phase: 'pull', currentChunk: page, totalChunks: page + (more ? 1 : 0), percent: more ? 50 + Math.min(45, page * 5) : 100, bytesTransferred: bytes });
      }

      // ---------- done ----------
      const totalDuration = Math.round(performance.now() - startTime);
      this.metrics.lastSyncLatencyMs = totalDuration;
      this.metrics.totalBytesSynced += bytes;
      this.metrics.totalSyncsCompleted++;
      this.metrics.pushedTotal += pushed;
      this.metrics.pulledTotal += pulled;
      this.metrics.conflictsDetected += conflicts;
      this.metrics.lastSyncAt = new Date().toISOString();
      this.metrics.lastStatus = 'ok';
      this._lsSet('ehr_metric_bytes', String(this.metrics.totalBytesSynced));
      this._lsSet('ehr_last_sync_at', this.metrics.lastSyncAt);

      this.isSyncing = false;
      if (pushed > 0 || pulled > 0) {
        window.dispatchEvent(new CustomEvent('ehr:sync-updated', { detail: { pushed, pulled, conflicts } }));
      }
      return {
        status: 'success', syncedCount: pushed, pushed, pulled, conflicts, bytes, latencyMs: totalDuration,
        message: pushed === 0 && pulled === 0
          ? 'Everything is up to date.'
          : `Sync complete: sent ${pushed}, received ${pulled} change(s)${conflicts ? `, ${conflicts} conflict(s) need review` : ''} in ${totalDuration}ms.`
      };
    } catch (err) {
      this.isSyncing = false;
      this.metrics.lastStatus = 'error';
      console.error('Sync failure:', err);
      const net = err instanceof TypeError; // fetch network failure
      return {
        status: 'error', error: err.message,
        message: net ? 'Network unreachable. Changes are safe locally and will sync later.' : `Sync failed: ${err.message}`
      };
    } finally {
      this.isSyncing = false;
    }
  }

  interruptSync() { this.abortCurrentSync = true; }

  // ---------- helpers ----------
  _wire(d) {
    return { deltaId: d.deltaId, type: d.type, entityId: d.entityId, patientId: d.patientId, nodeId: d.nodeId || this.hlc.nodeId, hlc: d.hlc, data: d.data };
  }

  _makeChunks(deltas) {
    const chunks = [];
    let cur = [], curBytes = 0;
    for (const d of deltas) {
      const size = JSON.stringify(d.data || {}).length + 300;
      if (cur.length > 0 && (cur.length >= this.maxChunkDeltas || curBytes + size > this.maxChunkBytes)) {
        chunks.push(cur); cur = []; curBytes = 0;
      }
      cur.push(d); curBytes += size;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  async _httpError(res) {
    if (res.ok) return null;
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* not json */ }
    if (res.status === 401) return { status: 'unauthorized', message: this.getClinicKey() ? 'Wrong Clinic Sync Key. Check it and try again.' : 'This hub requires a Clinic Sync Key. Enter it in the Sync tab.' };
    if (res.status === 503) return { status: 'server_not_ready', message: msg || 'Cloud hub is not configured yet (database or key missing).' };
    if (res.status === 404) return { status: 'server_not_ready', message: 'Cloud API not found. Is the /api folder deployed?' };
    if (res.status === 413) return { status: 'error', message: 'A record was too large to upload (long voice note?).' };
    return { status: 'error', message: msg || `Server error ${res.status}` };
  }

  _finishWithError(err) {
    this.isSyncing = false;
    this.metrics.lastStatus = err.status;
    return err;
  }

  _interrupted(chunkNo, total, pushed, pulled) {
    this.metrics.resumedSyncsCount++;
    this.isSyncing = false;
    return {
      status: 'interrupted', syncedCount: pushed, pushed, pulled,
      checkpoint: this.lastCheckpointHlc,
      message: `Sync interrupted at step ${chunkNo}/${total}. Progress is checkpointed; the next sync resumes from here.`
    };
  }

  getMetrics() { return { ...this.metrics, pullCursor: this.pullCursor }; }
}

if (typeof window !== 'undefined') {
  window.WeakLinkSyncService = WeakLinkSyncService;
}
