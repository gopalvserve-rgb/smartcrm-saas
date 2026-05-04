#!/usr/bin/env node
// Run schema.sql against DATABASE_URL.
// Usage:  node db/migrate.js        (or)   npm run migrate
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./pg');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  let exitCode = 0;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('✓ Schema applied successfully.');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('✗ Migration failed:', e.message);
      exitCode = 1;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('✗ Migration connection failed:', e.message);
    exitCode = 1;
  }
  // Don't await pool.end() — it can hang on some managed Postgres providers.
  // Fire-and-forget and exit immediately so the `&&` chain can continue.
  pool.end().catch(() => {});
  setImmediate(() => process.exit(exitCode));
})();
