/**
 * Offline Storage Engine for Village EHR
 * Primary storage: IndexedDB (scalable, handles audio blobs & thousands of patient logs)
 * Fallback storage: LocalStorage
 * Stores: patients, logs, audio_notes, deltas (resumable queue), conflicts
 */

class HealthStorageEngine {
  constructor() {
    this.dbName = 'RuralHealthOfflineEHR_v2';
    this.version = 1;
    this.db = null;
    this.isReady = false;
    this.initPromise = this.initDB();
  }

  async initDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        console.warn('IndexedDB not supported, falling back to LocalStorage');
        this.isReady = true;
        resolve(false);
        return;
      }

      const request = window.indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Patients Master Store
        if (!db.objectStoreNames.contains('patients')) {
          const patientStore = db.createObjectStore('patients', { keyPath: 'patientId' });
          patientStore.createIndex('name', 'name', { unique: false });
          patientStore.createIndex('updatedHlc', 'updatedHlc', { unique: false });
        }

        // Immutable Encounter Logs Store (Append-Only)
        if (!db.objectStoreNames.contains('logs')) {
          const logStore = db.createObjectStore('logs', { keyPath: 'logId' });
          logStore.createIndex('patientId', 'patientId', { unique: false });
          logStore.createIndex('hlc', 'hlc', { unique: false });
        }

        // Voice Notes Audio Store
        if (!db.objectStoreNames.contains('audio_notes')) {
          db.createObjectStore('audio_notes', { keyPath: 'voiceNoteId' });
        }

        // Resumable Delta Sync Queue
        if (!db.objectStoreNames.contains('deltas')) {
          const deltaStore = db.createObjectStore('deltas', { keyPath: 'deltaId' });
          deltaStore.createIndex('hlc', 'hlc', { unique: false });
          deltaStore.createIndex('acked', 'acked', { unique: false });
        }

        // Explicit Conflicts Store
        if (!db.objectStoreNames.contains('conflicts')) {
          const conflictStore = db.createObjectStore('conflicts', { keyPath: 'conflictId' });
          conflictStore.createIndex('patientId', 'patientId', { unique: false });
          conflictStore.createIndex('status', 'status', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        this.isReady = true;
        resolve(true);
      };

      request.onerror = (event) => {
        console.error('IndexedDB open error:', event.target.error);
        this.isReady = true;
        resolve(false);
      };
    });
  }

  // --- Patient CRUD ---

  async savePatient(patient, createDelta = true) {
    await this.initPromise;
    patient.updatedAt = new Date().toISOString();
    
    if (this.db) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(['patients'], 'readwrite');
        const store = tx.objectStore('patients');
        const req = store.put(patient);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } else {
      localStorage.setItem(`patient_${patient.patientId}`, JSON.stringify(patient));
    }

    if (createDelta && window.hlcService) {
      const deltaHlc = window.hlcService.now();
      await this.recordDelta({
        type: 'PATIENT_UPSERT',
        entityId: patient.patientId,
        hlc: deltaHlc.toString(),
        data: patient
      });
    }

    return patient;
  }

  async getPatient(patientId) {
    await this.initPromise;
    if (!patientId) return null;
    patientId = String(patientId).trim();

    if (this.db) {
      return new Promise((resolve) => {
        const tx = this.db.transaction(['patients'], 'readonly');
        const store = tx.objectStore('patients');
        const req = store.get(patientId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } else {
      const raw = localStorage.getItem(`patient_${patientId}`);
      return raw ? JSON.parse(raw) : null;
    }
  }

  async getAllPatients() {
    await this.initPromise;
    if (this.db) {
      return new Promise((resolve) => {
        const tx = this.db.transaction(['patients'], 'readonly');
        const store = tx.objectStore('patients');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } else {
      const patients = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('patient_')) {
          try {
            patients.push(JSON.parse(localStorage.getItem(key)));
          } catch (e) {}
        }
      }
      return patients;
    }
  }

  // --- Append-Only Encounter Logs ---

  async saveLog(log, createDelta = true) {
    await this.initPromise;
    if (!log.logId) {
      log.logId = 'LOG-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
    }
    if (!log.timestamp) {
      log.timestamp = new Date().toISOString();
    }
    if (!log.hlc && window.hlcService) {
      log.hlc = window.hlcService.now().toString();
    }

    // Tamper-evident hash calculation
    if (window.HealthCrypto) {
      log.hash = await window.HealthCrypto.computeHash({
        logId: log.logId,
        patientId: log.patientId,
        diseaseType: log.diseaseType,
        prescription: log.prescription,
        description: log.description,
        hlc: log.hlc
      });
    }

    if (this.db) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(['logs'], 'readwrite');
        const store = tx.objectStore('logs');
        const req = store.put(log);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } else {
      const list = JSON.parse(localStorage.getItem(`logs_${log.patientId}`) || '[]');
      list.push(log);
      localStorage.setItem(`logs_${log.patientId}`, JSON.stringify(list));
    }

    if (createDelta && window.hlcService) {
      await this.recordDelta({
        type: 'LOG_APPEND',
        entityId: log.logId,
        patientId: log.patientId,
        hlc: log.hlc,
        data: log
      });
    }

    return log;
  }

  async getLogsForPatient(patientId) {
    await this.initPromise;
    if (!patientId) return [];

    let logs = [];
    if (this.db) {
      logs = await new Promise((resolve) => {
        const tx = this.db.transaction(['logs'], 'readonly');
        const store = tx.objectStore('logs');
        const index = store.index('patientId');
        const req = index.getAll(patientId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } else {
      logs = JSON.parse(localStorage.getItem(`logs_${patientId}`) || '[]');
    }

    // Sort chronologically using HLC or timestamp
    logs.sort((a, b) => {
      if (a.hlc && b.hlc && window.HLC) {
        return window.HLC.compare(window.HLC.parse(a.hlc), window.HLC.parse(b.hlc));
      }
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });

    return logs;
  }

  // --- Voice Notes (Audio Blobs) ---

  async saveVoiceNote(voiceNoteId, audioBase64, durationSec = 0) {
    await this.initPromise;
    const note = {
      voiceNoteId,
      audioBase64,
      durationSec,
      createdAt: new Date().toISOString()
    };

    if (this.db) {
      await new Promise((resolve) => {
        const tx = this.db.transaction(['audio_notes'], 'readwrite');
        const store = tx.objectStore('audio_notes');
        const req = store.put(note);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      });
    } else {
      try {
        localStorage.setItem(`voice_${voiceNoteId}`, JSON.stringify(note));
      } catch (e) {
        console.warn('LocalStorage audio quota exceeded');
      }
    }
    return note;
  }

  async getVoiceNote(voiceNoteId) {
    await this.initPromise;
    if (!voiceNoteId) return null;

    if (this.db) {
      return new Promise((resolve) => {
        const tx = this.db.transaction(['audio_notes'], 'readonly');
        const store = tx.objectStore('audio_notes');
        const req = store.get(voiceNoteId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } else {
      const raw = localStorage.getItem(`voice_${voiceNoteId}`);
      return raw ? JSON.parse(raw) : null;
    }
  }

  // --- Resumable Deltas & Outbox Queue ---

  async recordDelta(delta) {
    await this.initPromise;
    delta.deltaId = delta.deltaId || 'DELTA-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    delta.acked = delta.acked || 0;
    delta.createdAt = new Date().toISOString();

    if (this.db) {
      return new Promise((resolve) => {
        const tx = this.db.transaction(['deltas'], 'readwrite');
        const store = tx.objectStore('deltas');
        const req = store.put(delta);
        req.onsuccess = () => resolve(delta);
        req.onerror = () => resolve(delta);
      });
    } else {
      const deltas = JSON.parse(localStorage.getItem('outbox_deltas') || '[]');
      deltas.push(delta);
      localStorage.setItem('outbox_deltas', JSON.stringify(deltas));
      return delta;
    }
  }

  async getUnsyncedDeltas() {
    await this.initPromise;
    if (this.db) {
      const allDeltas = await new Promise((resolve) => {
        const tx = this.db.transaction(['deltas'], 'readonly');
        const store = tx.objectStore('deltas');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
      return allDeltas.filter(d => !d.acked);
    } else {
      const list = JSON.parse(localStorage.getItem('outbox_deltas') || '[]');
      return list.filter(d => !d.acked);
    }
  }

  async markDeltasAcked(deltaIds) {
    await this.initPromise;
    if (!Array.isArray(deltaIds) || deltaIds.length === 0) return;
    const idSet = new Set(deltaIds);

    if (this.db) {
      const tx = this.db.transaction(['deltas'], 'readwrite');
      const store = tx.objectStore('deltas');
      for (const id of idSet) {
        const req = store.get(id);
        req.onsuccess = () => {
          if (req.result) {
            req.result.acked = 1;
            store.put(req.result);
          }
        };
      }
    } else {
      const list = JSON.parse(localStorage.getItem('outbox_deltas') || '[]');
      list.forEach(d => {
        if (idSet.has(d.deltaId)) d.acked = 1;
      });
      localStorage.setItem('outbox_deltas', JSON.stringify(list));
    }
  }

  // --- Explicit Conflicts Store ---

  async saveConflict(conflict) {
    await this.initPromise;
    conflict.conflictId = conflict.conflictId || 'CONF-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
    conflict.status = conflict.status || 'OPEN'; // 'OPEN' or 'RESOLVED'
    conflict.detectedAt = conflict.detectedAt || new Date().toISOString();

    if (this.db) {
      return new Promise((resolve) => {
        const tx = this.db.transaction(['conflicts'], 'readwrite');
        const store = tx.objectStore('conflicts');
        const req = store.put(conflict);
        req.onsuccess = () => resolve(conflict);
        req.onerror = () => resolve(conflict);
      });
    } else {
      const conflicts = JSON.parse(localStorage.getItem('clinic_conflicts') || '[]');
      conflicts.push(conflict);
      localStorage.setItem('clinic_conflicts', JSON.stringify(conflicts));
      return conflict;
    }
  }

  async getActiveConflicts() {
    await this.initPromise;
    if (this.db) {
      const all = await new Promise((resolve) => {
        const tx = this.db.transaction(['conflicts'], 'readonly');
        const store = tx.objectStore('conflicts');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
      return all.filter(c => c.status === 'OPEN');
    } else {
      const list = JSON.parse(localStorage.getItem('clinic_conflicts') || '[]');
      return list.filter(c => c.status === 'OPEN');
    }
  }

  async resolveConflict(conflictId, resolutionChoice) {
    await this.initPromise;
    if (this.db) {
      const tx = this.db.transaction(['conflicts'], 'readwrite');
      const store = tx.objectStore('conflicts');
      const req = store.get(conflictId);
      req.onsuccess = () => {
        if (req.result) {
          req.result.status = 'RESOLVED';
          req.result.resolvedAt = new Date().toISOString();
          req.result.resolutionChoice = resolutionChoice;
          store.put(req.result);
        }
      };
    }
  }

  // --- Backup & Disaster Recovery ---

  async exportFullBackup() {
    const patients = await this.getAllPatients();
    let allLogs = [];
    if (this.db) {
      allLogs = await new Promise((resolve) => {
        const tx = this.db.transaction(['logs'], 'readonly');
        const req = tx.objectStore('logs').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    }
    return {
      exportedAt: new Date().toISOString(),
      nodeId: window.hlcService ? window.hlcService.nodeId : 'CLINIC-BACKUP',
      hlcSnapshot: window.hlcService ? window.hlcService.getSnapshot().toString() : '',
      patients,
      logs: allLogs
    };
  }

  async importBackup(backupData) {
    if (!backupData || !Array.isArray(backupData.patients)) return false;
    for (const p of backupData.patients) {
      await this.savePatient(p, false);
    }
    if (Array.isArray(backupData.logs)) {
      for (const l of backupData.logs) {
        await this.saveLog(l, false);
      }
    }
    return true;
  }
}

if (typeof window !== 'undefined') {
  window.healthStorage = new HealthStorageEngine();
}
