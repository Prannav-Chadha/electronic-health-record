import { neon } from '@neondatabase/serverless';

/**
 * Returns a db adapter for Neon, or null if no connection string is configured.
 * Vercel's Neon integration sets DATABASE_URL (and POSTGRES_URL).
 */
export function getNeonDb() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
  if (!url) return null;
  const sql = neon(url);
  return {
    query: (text, params = []) => sql.query(text, params),
    batch: (stmts) => sql.transaction((txn) => stmts.map(s => txn.query(s.text, s.params || [])))
  };
}
