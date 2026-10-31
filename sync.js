import { makeSyncHandler } from './_lib.js';
import { getNeonDb } from './_db.js';

const db = getNeonDb();

export default async function handler(req, res) {
  if (!db) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'no_database', message: 'No DATABASE_URL. Connect a Neon Postgres database to this Vercel project.' }));
  }
  return makeSyncHandler(db)(req, res);
}
