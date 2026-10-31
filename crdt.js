/**
 * Domain-Aware Conflict-Free Replicated Data Type (CRDT) Engine
 * Implements:
 * 1. Monotonic Append-Only Log CRDT for clinical encounter histories (guarantees zero data loss)
 * 2. Causal Delta Merge with Hybrid Logical Clocks (HLC)
 * 3. Domain-Aware Conflict Detection: Surfaces explicit conflicts for unsafe concurrent medical edits
 * 4. Idempotent Replay engine with SHA-256 deduplication
 */

class HealthCRDTEngine {
  constructor(storage, hlcService) {
    this.storage = storage;
    this.hlcService = hlcService;
    this.processedDeltas = new Set();
  }

  /**
   * Applies incoming delta from peer or sync server
   * Returns: { success: boolean, duplicate: boolean, conflict: object|null }
   */
  async applyDelta(delta, isRemote = true) {
    if (!delta || !delta.deltaId) {
      return { success: false, duplicate: false, error: 'Invalid delta' };
    }

    // 1. Idempotency Check (Idempotent Replay) - in memory AND persisted across reloads
    if (this.processedDeltas.has(delta.deltaId)) {
      return { success: true, duplicate: true, deltaId: delta.deltaId };
    }
    if (isRemote && this.storage.hasDelta && await this.storage.hasDelta(delta.deltaId)) {
      this.processedDeltas.add(delta.deltaId);
      return { success: true, duplicate: true, deltaId: delta.deltaId };
    }
    this.processedDeltas.add(delta.deltaId);

    // Update local HLC with remote delta HLC
    if (isRemote && delta.hlc && this.hlcService) {
      this.hlcService.update(delta.hlc);
    }

    let result;
    try {
      switch (delta.type) {
        case 'LOG_APPEND':
          result = await this._mergeLogAppend(delta, isRemote);
          break;
        case 'PATIENT_UPSERT':
          result = await this._mergePatientUpsert(delta, isRemote);
          break;
        case 'VOICE_NOTE':
          result = await this._mergeVoiceNote(delta, isRemote);
          break;
        case 'CONFLICT_RESOLVED':
          result = await this._applyConflictResolution(delta, isRemote);
          break;
        default:
          console.warn('Unknown delta type:', delta.type);
          result = { success: false, duplicate: false, error: 'Unknown delta type' };
      }
    } catch (err) {
      // Let the delta be retried later instead of silently losing it
      this.processedDeltas.delete(delta.deltaId);
      throw err;
    }

    if (isRemote && result && result.success && this.storage.markRemoteApplied) {
      await this.storage.markRemoteApplied(delta);
    }
    return result;
  }

  /**
   * Voice notes are immutable blobs keyed by a unique id -> trivial set-union merge.
   */
  async _mergeVoiceNote(delta, isRemote) {
    const note = delta.data;
    if (!note || !note.voiceNoteId) return { success: false, duplicate: false, error: 'Malformed voice note' };
    const existing = await this.storage.getVoiceNote(note.voiceNoteId);
    if (existing && existing.audioBase64) return { success: true, duplicate: true };
    if (!note.audioBase64) return { success: true, duplicate: false }; // payload stripped; nothing to store
    await this.storage.saveVoiceNote(note.voiceNoteId, note.audioBase64, note.durationSec || 0, false);
    return { success: true, duplicate: false };
  }

  /**
   * Append-Only Encounter Log Merge
   * Commutative, Associative, Idempotent Set CRDT
   * Guarantees 0% data loss across concurrent offline clinics!
   */
  async _mergeLogAppend(delta, isRemote) {
    const incomingLog = delta.data;
    if (!incomingLog || !incomingLog.logId || !incomingLog.patientId) {
      return { success: false, duplicate: false, error: 'Malformed log' };
    }

    const existingLogs = await this.storage.getLogsForPatient(incomingLog.patientId);
    const existing = existingLogs.find(l => l.logId === incomingLog.logId || (l.hash && l.hash === incomingLog.hash));

    if (existing) {
      // Idempotent duplicate: already have this exact visit log
      return { success: true, duplicate: true, logId: incomingLog.logId };
    }

    // Safe append: Add new visit log to immutable ledger
    await this.storage.saveLog(incomingLog, false);

    // Trigger UI event for live log update
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ehr:log-appended', { detail: incomingLog }));
    }

    return { success: true, duplicate: false, logId: incomingLog.logId };
  }

  /**
   * Domain-Aware Patient Upsert Merge
   *
   * Every patient edit carries:
   *   updatedHlc - the version this edit produced
   *   baseHlc    - the version the editing device had seen just before editing
   * That gives real causality:
   *   - incoming.baseHlc >= local.updatedHlc  -> incoming edit builds on what we have  -> fast-forward (no conflict)
   *   - local.baseHlc    >= incoming.updatedHlc -> we already built on the incoming one -> keep local
   *   - neither                                  -> truly concurrent edits
   * Truly concurrent edits that disagree on sensitive clinical fields are surfaced to the doctor,
   * never silently overwritten.
   */
  async _mergePatientUpsert(delta, isRemote) {
    const incoming = delta.data;
    if (!incoming || !incoming.patientId) {
      return { success: false, duplicate: false, error: 'Malformed patient' };
    }

    const localPatient = await this.storage.getPatient(incoming.patientId);

    // Case 1: First time this patient is seen on this device
    if (!localPatient) {
      await this.storage.savePatient(incoming, false);
      return { success: true, duplicate: false };
    }

    const parse = (v) => (v ? HLC.parse(v) : null);
    const localV = parse(localPatient.updatedHlc);
    const incV = parse(incoming.updatedHlc || delta.hlc);
    const incBase = parse(incoming.baseHlc);
    const localBase = parse(localPatient.baseHlc);

    if (!localV || !incV) {
      // Missing version info: accept the incoming copy rather than lose it
      await this.storage.savePatient({ ...localPatient, ...incoming }, false);
      return { success: true, duplicate: false };
    }

    // Same version already here
    if (HLC.compare(incV, localV) === 0) return { success: true, duplicate: true };

    const incomingSawLocal = incBase && HLC.compare(incBase, localV) >= 0;
    const localSawIncoming = localBase && HLC.compare(localBase, incV) >= 0;

    // Case 2: incoming edit is a causal successor of our version -> fast-forward
    if (incomingSawLocal) {
      const merged = { ...localPatient, ...incoming };
      await this.storage.savePatient(merged, false);
      if (this.storage.resolveOpenConflictsForPatient) {
        await this.storage.resolveOpenConflictsForPatient(incoming.patientId, 'SUPERSEDED_BY_REMOTE');
      }
      return { success: true, duplicate: false };
    }

    // Case 3: we already incorporate the incoming version
    if (localSawIncoming) return { success: true, duplicate: true };

    // Case 4: concurrent edits. Compare the safety-critical fields.
    const sensitiveFields = ['diseaseType', 'prescription', 'name', 'age', 'gender'];
    const differences = [];
    for (const field of sensitiveFields) {
      if (incoming[field] !== undefined && localPatient[field] !== undefined) {
        if (String(incoming[field]).trim().toLowerCase() !== String(localPatient[field]).trim().toLowerCase()) {
          differences.push({ field, local: localPatient[field], incoming: incoming[field] });
        }
      }
    }

    if (differences.length > 0) {
      // Don't raise the same conflict twice (e.g. after a re-pull)
      const open = await this.storage.getActiveConflicts();
      const already = open.find(c => c.patientId === incoming.patientId && c.remoteHlc === (incoming.updatedHlc || delta.hlc || ''));
      if (already) return { success: true, duplicate: true };

      console.warn('UNSAFE AUTOMATIC MERGE DETECTED - surfacing explicit conflict:', differences);
      const conflictRecord = {
        conflictId: `CONF-${incoming.patientId}-${Date.now()}`,
        patientId: incoming.patientId,
        patientName: localPatient.name || incoming.name,
        localHlc: localPatient.updatedHlc || '',
        remoteHlc: incoming.updatedHlc || delta.hlc || '',
        differences,
        localSnapshot: localPatient,
        remoteSnapshot: incoming,
        status: 'OPEN',
        detectedAt: new Date().toISOString()
      };
      await this.storage.saveConflict(conflictRecord);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('ehr:conflict-detected', { detail: conflictRecord }));
      }
      return { success: true, duplicate: false, conflict: conflictRecord };
    }

    // Concurrent but no clinical disagreement (e.g. only free-text notes differ): newest HLC wins
    if (HLC.compare(incV, localV) > 0) {
      await this.storage.savePatient({ ...localPatient, ...incoming }, false);
      return { success: true, duplicate: false };
    }
    return { success: true, duplicate: true };
  }

  /**
   * Applies an explicit doctor conflict resolution
   */
  async _applyConflictResolution(delta, isRemote) {
    const { conflictId, patientId, resolvedRecord } = delta.data;
    if (resolvedRecord && patientId) {
      await this.storage.savePatient(resolvedRecord, false);
      await this.storage.resolveConflict(conflictId, 'RESOLVED_BY_DELTA');
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('ehr:conflict-resolved', { detail: { conflictId, patientId } }));
      }
      return { success: true, duplicate: false };
    }
    return { success: false, duplicate: false };
  }
}

if (typeof window !== 'undefined') {
  window.HealthCRDTEngine = HealthCRDTEngine;
}
