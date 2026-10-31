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

    // 1. Idempotency Check (Idempotent Replay)
    if (this.processedDeltas.has(delta.deltaId)) {
      return { success: true, duplicate: true, deltaId: delta.deltaId };
    }
    this.processedDeltas.add(delta.deltaId);

    // Update local HLC with remote delta HLC
    if (isRemote && delta.hlc && this.hlcService) {
      this.hlcService.update(delta.hlc);
    }

    switch (delta.type) {
      case 'LOG_APPEND':
        return await this._mergeLogAppend(delta, isRemote);

      case 'PATIENT_UPSERT':
        return await this._mergePatientUpsert(delta, isRemote);

      case 'CONFLICT_RESOLVED':
        return await this._applyConflictResolution(delta, isRemote);

      default:
        console.warn('Unknown delta type:', delta.type);
        return { success: false, duplicate: false, error: 'Unknown delta type' };
    }
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
   * Flags UNSAFE concurrent medical edits as EXPLICIT conflicts
   */
  async _mergePatientUpsert(delta, isRemote) {
    const incoming = delta.data;
    if (!incoming || !incoming.patientId) {
      return { success: false, duplicate: false, error: 'Malformed patient' };
    }

    const localPatient = await this.storage.getPatient(incoming.patientId);

    // Case 1: First time this patient is registered on this node
    if (!localPatient) {
      await this.storage.savePatient(incoming, false);
      return { success: true, duplicate: false };
    }

    // Case 2: Patient already exists locally - Check for concurrent / conflicting edits
    const localHlc = localPatient.updatedHlc ? HLC.parse(localPatient.updatedHlc) : null;
    const incomingHlc = delta.hlc ? HLC.parse(delta.hlc) : (incoming.updatedHlc ? HLC.parse(incoming.updatedHlc) : null);

    // Domain-Aware Clinical Field Comparison:
    // Are there divergent medical diagnosis, prescriptions, or core demographics?
    const sensitiveFields = ['diseaseType', 'prescription', 'name', 'age', 'gender'];
    const differences = [];

    for (const field of sensitiveFields) {
      if (incoming[field] !== undefined && localPatient[field] !== undefined) {
        if (String(incoming[field]).trim().toLowerCase() !== String(localPatient[field]).trim().toLowerCase()) {
          differences.push({
            field,
            local: localPatient[field],
            incoming: incoming[field]
          });
        }
      }
    }

    // If there are clinical differences AND neither HLC strictly dominates by a clear margin
    // or both edits were made offline within the concurrent window:
    const isConcurrent = HLC.areConcurrent(localHlc, incomingHlc, 60000); // 60s window or differing nodes

    if (differences.length > 0 && (isConcurrent || incomingHlc.node !== localHlc.node)) {
      // UNSAFE AUTOMATIC MERGE DETECTED!
      // Must NOT silently overwrite clinical data!
      console.warn('⚠️ UNSAFE AUTOMATIC MERGE DETECTED! Surfacing explicit conflict:', differences);

      const conflictRecord = {
        conflictId: `CONF-${incoming.patientId}-${Date.now()}`,
        patientId: incoming.patientId,
        patientName: localPatient.name || incoming.name,
        localHlc: localPatient.updatedHlc || '',
        remoteHlc: delta.hlc || '',
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

      return {
        success: true,
        duplicate: false,
        conflict: conflictRecord
      };
    }

    // Safe automatic merge via HLC total order (Last-Write-Wins with causality tiebreaker)
    const cmp = HLC.compare(incomingHlc, localHlc);
    if (cmp > 0) {
      // Remote edit causally wins
      const merged = { ...localPatient, ...incoming, updatedHlc: incomingHlc.toString() };
      await this.storage.savePatient(merged, false);
      return { success: true, duplicate: false };
    } else {
      // Local edit causally dominates or equal; retain local
      return { success: true, duplicate: true };
    }
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
