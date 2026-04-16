#!/usr/bin/env node
/**
 * scripts/run-custom-migrations.js
 *
 * Applies custom TypeORM migrations (src/migrations/*.ts, compiled to
 * .medusa/server/src/migrations/*.js) to the database on every deploy.
 *
 * WHY THIS EXISTS:
 *   `medusa db:migrate --execute-safe-links` only runs Medusa framework core
 *   migrations (MikroORM-based). Our project-specific TypeORM migrations in
 *   src/migrations/ are NOT discovered or run by that command. This script
 *   fills that gap and must be called after `medusa db:migrate`.
 *
 * TRACKING:
 *   Applied migrations are recorded in the `custom_migrations` table (TypeORM
 *   default format). This table is created automatically on first run. All
 *   migrations are idempotent, so re-running on a fresh table is safe.
 *
 * USAGE (predeploy):
 *   medusa db:migrate --execute-safe-links && node scripts/run-custom-migrations.js
 */

'use strict';

const path = require('path');
const fs = require('fs');

// ── 1. Load .env (Railway sets env vars natively; this is for local runs) ────

const envFile = path.join(__dirname, '../.env');
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
    if (match && !Object.prototype.hasOwnProperty.call(process.env, match[1])) {
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ [custom-migrations] DATABASE_URL is not set — cannot run migrations.');
  process.exit(1);
}

// ── 2. Resolve compiled migration files ─────────────────────────────────────
// `medusa build` compiles src/migrations/*.ts → .medusa/server/src/migrations/*.js

const MIGRATIONS_DIR = path.join(__dirname, '../.medusa/server/src/migrations');

async function main() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.warn(`⚠️  [custom-migrations] Compiled migrations dir not found: ${MIGRATIONS_DIR}`);
    console.warn('    Build the project first with `medusa build`, or this is a dev environment.');
    console.log('✅ [custom-migrations] Skipping — nothing to run.');
    return;
  }

  // Collect all .js migration files, sorted by filename (timestamp prefix = correct order)
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();

  if (files.length === 0) {
    console.log('✅ [custom-migrations] No compiled migration files found — nothing to run.');
    return;
  }

  // Dynamically require each file and collect TypeORM migration classes only.
  // MikroORM migrations also have up() but with zero parameters (no queryRunner).
  // TypeORM migrations require up(queryRunner), so function.length >= 1 is the discriminator.
  const migrationClasses = [];
  for (const file of files) {
    const mod = require(path.join(MIGRATIONS_DIR, file));
    for (const exported of Object.values(mod)) {
      if (
        typeof exported === 'function' &&
        exported.prototype &&
        typeof exported.prototype.up === 'function' &&
        exported.prototype.up.length >= 1  // TypeORM: up(queryRunner) — MikroORM: up()
      ) {
        migrationClasses.push(exported);
      }
    }
  }

  if (migrationClasses.length === 0) {
    console.log('✅ [custom-migrations] No migration classes found in compiled files.');
    return;
  }

  console.log(`🔍 [custom-migrations] Found ${migrationClasses.length} migration(s) in ${files.length} file(s).`);

  // ── 3. Run via TypeORM DataSource ─────────────────────────────────────────
  const { DataSource } = require('typeorm');

  const isProduction = process.env.NODE_ENV === 'production';

  const ds = new DataSource({
    type: 'postgres',
    url: DATABASE_URL,
    // Railway uses SSL; local dev typically doesn't need it
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    migrations: migrationClasses,
    // Separate table from Medusa internals — never conflicts with mikro_orm_migrations
    migrationsTableName: 'custom_migrations',
    logging: false,
  });

  try {
    await ds.initialize();
    console.log('🔌 [custom-migrations] Connected to database.');

    const ran = await ds.runMigrations({ transaction: 'each' });

    if (ran.length === 0) {
      console.log('✅ [custom-migrations] All custom migrations already applied — nothing to do.');
    } else {
      console.log(`✅ [custom-migrations] Applied ${ran.length} migration(s):`);
      for (const m of ran) {
        console.log(`   ✔  ${m.name}`);
      }
    }
  } finally {
    await ds.destroy().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ [custom-migrations] Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
