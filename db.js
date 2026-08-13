import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ssl = String(process.env.PGSSL || '').toLowerCase() === 'true'
  ? { rejectUnauthorized: false }
  : undefined;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: Number(process.env.PG_POOL_MAX || 12),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

export async function migrate() {
  const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function healthCheck() {
  const result = await pool.query('SELECT NOW() AS now');
  return result.rows[0].now;
}
