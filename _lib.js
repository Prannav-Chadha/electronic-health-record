/**
 * Shared server logic for the EHR cloud sync API.
 * Files starting with "_" inside /api are NOT exposed as Vercel functions.
 *
 * db interface (implemented for Neon in _db.js, for PGlite in tests):
 *   db.query(text, params)  -> Promise<row[]>
 *   db.batch([{text,params}]) -> Promise<row[][]>   (single transaction)
 */
import { timingSafeEqual } from 'node:crypto';

export const MAX_PUSH_DELTAS = 50;
export const PULL_BYTE_BUDGET = 3 * 1024 * 1024; // Vercel responses are capped at ~4.5 MB
export const PULL_MAX_ROWS = 200;
const ALLOWED_TYPES = new Set(['PATIENT_UPSERT', 'LOG_APPEND', 'VOICE_NOTE', 'CONFLICT_RESOLVED']);

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    {
      text: `CREATE TABLE IF NOT EXISTS ehr_deltas (
        seq         BIGSERIAL PRIMARY KEY,
        delta_id    TEXT UNIQUE NOT NULL,
        delta_type  TEXT NOT NULL,
        entity_id   TEXT,
        patient_id  TEXT,
        node_id     TEXT,
        hlc         TEXT,
        data        JSONB NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    },
    { text: `CREATE INDEX IF NOT EXISTS ehr_deltas_patient_idx ON ehr_deltas (patient_id)` }
  ]);
  schemaReady = true;
}

/** Reset the cached flag (used by tests that recreate the DB). */
export function _resetSchemaCache() { schemaReady = false; }

function keyOk(req) {
  const expected = process.env.CLINIC_SYNC_KEY || '';
  // No key configured = open mode (fine for demos with fake data). Set CLINIC_SYNC_KEY to lock it down.
  if (!expected) return 'open';
  const given = String(req.headers['x-clinic-key'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return 'bad_key';
  return timingSafeEqual(a, b) ? 'ok' : 'bad_key';
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function authGate(req, res) {
  const k = keyOk(req);
  if (k === 'bad_key') {
    send(res, 401, { error: 'unauthorized', message: 'Wrong clinic key.' });
    return false;
  }
  return true;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel pre-parses JSON
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function validDelta(d) {
  return d && typeof d === 'object'
    && typeof d.deltaId === 'string' && d.deltaId.length > 0 && d.deltaId.length <= 200
    && ALLOWED_TYPES.has(d.type)
    && d.data && typeof d.data === 'object';
}

/** POST /api/sync  { deltas: [...] }  -> { ackedIds, inserted, rejected } */
export async function handlePush(db, req, res) {
  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad_json' }); }
  const deltas = Array.isArray(body.deltas) ? body.deltas : [];
  if (deltas.length > MAX_PUSH_DELTAS) return send(res, 413, { error: 'too_many', max: MAX_PUSH_DELTAS });

  const good = deltas.filter(validDelta);
  const rejected = deltas.filter(d => !validDelta(d)).map(d => (d && d.deltaId) || null);

  await ensureSchema(db);
  if (good.length > 0) {
    // One transaction. The advisory lock serialises writers so that `seq` order == commit order,
    // which makes the pull cursor safe (no row can commit "behind" a cursor a client already holds).
    const stmts = [{ text: 'SELECT pg_advisory_xact_lock(727001)', params: [] }];
    for (const d of good) {
      stmts.push({
        text: `INSERT INTO ehr_deltas (delta_id, delta_type, entity_id, patient_id, node_id, hlc, data)
               VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
               ON CONFLICT (delta_id) DO NOTHING`,
        params: [
          d.deltaId, d.type,
          d.entityId || null,
          d.patientId || (d.data && d.data.patientId) || null,
          d.nodeId || null,
          d.hlc || null,
          JSON.stringify(d.data)
        ]
      });
    }
    await db.batch(stmts);
  }
  return send(res, 200, { status: 'ok', ackedIds: good.map(d => d.deltaId), rejected });
}

/** GET /api/sync?since=<seq>  -> { deltas, cursor, hasMore } */
export async function handlePull(db, req, res, url) {
  const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
  await ensureSchema(db);

  const sizes = await db.query(
    `SELECT seq, octet_length(data::text) AS sz FROM ehr_deltas
     WHERE seq > $1 ORDER BY seq ASC LIMIT ${PULL_MAX_ROWS + 1}`, [since]);

  let used = 0, upto = since, taken = 0;
  for (const r of sizes.slice(0, PULL_MAX_ROWS)) {
    const sz = Number(r.sz) + 300;
    if (taken > 0 && used + sz > PULL_BYTE_BUDGET) break;
    used += sz; upto = Number(r.seq); taken++;
  }
  if (taken === 0) return send(res, 200, { deltas: [], cursor: since, hasMore: false });

  const rows = await db.query(
    `SELECT seq, delta_id, delta_type, entity_id, patient_id, node_id, hlc, data
     FROM ehr_deltas WHERE seq > $1 AND seq <= $2 ORDER BY seq ASC`, [since, upto]);

  const deltas = rows.map(r => ({
    seq: Number(r.seq),
    deltaId: r.delta_id,
    type: r.delta_type,
    entityId: r.entity_id,
    patientId: r.patient_id,
    nodeId: r.node_id,
    hlc: r.hlc,
    data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data
  }));
  return send(res, 200, { deltas, cursor: upto, hasMore: sizes.length > taken });
}

export function makeSyncHandler(db) {
  return async function handler(req, res) {
    try {
      if (!authGate(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST') return await handlePush(db, req, res);
      if (req.method === 'GET') return await handlePull(db, req, res, url);
      res.setHeader('Allow', 'GET, POST');
      return send(res, 405, { error: 'method_not_allowed' });
    } catch (err) {
      console.error('sync error:', err);
      return send(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
  };
}

/** GET /api/status  (no key needed for liveness; key check result is reported) */
export function makeStatusHandler(db) {
  return async function handler(req, res) {
    const out = { service: 'ehr-cloud-sync', time: Date.now(), keyConfigured: !!process.env.CLINIC_SYNC_KEY, dbConfigured: !!db, db: 'unknown', keyAccepted: null };
    try {
      if (db) { await db.query('SELECT 1 AS ok', []); out.db = 'ok'; }
      else out.db = 'missing_env';
    } catch (e) { out.db = 'error'; out.dbError = String(e.message || e); }
    const k = keyOk(req);
    out.mode = process.env.CLINIC_SYNC_KEY ? 'key_required' : 'open';
    out.keyAccepted = k === 'ok' || k === 'open' ? true : (req.headers['x-clinic-key'] ? false : null);
    return send(res, 200, out);
  };
}
