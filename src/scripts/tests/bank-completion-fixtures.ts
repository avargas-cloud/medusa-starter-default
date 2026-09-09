/** V11-V13 safety evidence. This module has no database write or cleanup operation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { auditCompletionAdmin } from "../../lib/banking/bank-completion-admin";
import { requireBankingSandbox } from "../../lib/banking/security";

import { fingerprints } from "./bank-accounting-fixtures";

export const completionPrefix = "e2e_bank_completion_";
export const completionDirectory = "/tmp/ept-bank-completion-v11-v13";
export const completionLegacyMigrations = [
  "20260908193000",
  "20260908223000",
  "20260909005000",
  "20260909022000",
  "20260909040000",
  "20260909060000",
].map((timestamp) => `Migration${timestamp}`);
export const completionBankCaps: Record<string, number> = {
  bank_movement: 150,
  bank_movement_allocation: 2000,
  bank_source_claim: 3000,
  bank_evidence_document: 100,
  bank_merchant_settlement: 100,
  bank_merchant_settlement_line: 2000,
  bank_statement: 36,
  bank_statement_line: 5000,
  bank_statement_match: 5000,
  bank_connection: 3,
  bank_account: 10,
  bank_transaction: 2000,
  bank_transaction_review: 2000,
  bank_review_rule: 100,
  bank_day_close: 62,
  bank_review_permission: 25,
  bank_review_attachment: 25,
  bank_sync_run: 100,
  bank_webhook_event: 2000,
  bank_review_event: 10000,
  bank_deposit: 100,
  bank_deposit_line: 2000,
  bank_journal_entry: 2000,
  bank_journal_line: 10000,
  bank_direct_expense: 200,
  bank_accounting_setup: 10,
  bank_receipt_accounting: 200,
  bank_receipt_consumption: 2000,
  bank_opening_balance: 20,
  bank_opening_item: 2000,
  bank_opening_clear: 2000,
  bank_opening_evidence: 50,
};
export const completionFixtureCaps: Record<string, number> = {
  customer_payment: 60,
  vendor_bill: 12,
  vendor_bill_line: 48,
  china_wire_transfer: 8,
  china_wire_transfer_application: 16,
  china_finance_bill: 8,
  china_finance_wire_credit: 8,
  pos_monthly_payroll: 3,
  accounting_period_close: 20,
  inventory_valuation_snapshot: 40,
  inventory_valuation_snapshot_line: 200000,
};

/** Credentials are unnecessary for document-only tests; never load the production .env. */
export function configureCompletionSandbox(): void {
  for (const key of Object.keys(process.env)) {
    if (
      /^(AUTHORIZENET_|AUTHORIZE_NET_|BAMS_|PLAID_|RESEND_|SENDGRID_|MAILCHIMP_|SMTP_)/.test(
        key
      )
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, {
    ECOPOWERTECH_ENV: "sandbox",
    DATABASE_URL: "postgresql://postgres:sandbox@localhost:5499/medusa",
    REDIS_URL: "redis://localhost:6399",
    MEILISEARCH_HOST: "http://localhost:7799",
    MEILISEARCH_API_KEY: "sandbox_master_key",
    DISABLE_SCHEDULED_JOBS: "true",
    QB_BRIDGE_DISABLED: "true",
    QB_DRY_RUN: "true",
    QB_BRIDGE_URL: "http://localhost:9999/disabled",
    SMTP_DISABLED: "true",
    BAMS_WEBHOOK_DISABLED: "true",
    PLAID_ENV: "sandbox",
    MEDUSA_BACKEND_URL: "http://localhost:9099",
    MEDUSA_TELEMETRY_DISABLED: "true",
  });
  requireBankingSandbox();
}

export function completionHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function identifier(value: string): string {
  assert(/^[a-z_][a-z0-9_]*$/.test(value), "Catalog identifier is not safe");
  return `"${value}"`;
}
export async function completionColumns(client: PoolClient, tables: string[]) {
  return (
    await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      ordinal_position: number;
    }>(
      `SELECT table_name,column_name,data_type,is_nullable,
      column_default,ordinal_position FROM information_schema.columns
      WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position`,
      [tables]
    )
  ).rows;
}
/** Saving the old column list permits exact legacy-row comparison after additive ALTER TABLE. */
export async function completionTableFingerprints(
  client: PoolClient,
  columns: Awaited<ReturnType<typeof completionColumns>>
) {
  const names = new Map<string, string[]>();
  for (const column of columns)
    names.set(column.table_name, [
      ...(names.get(column.table_name) ?? []),
      column.column_name,
    ]);
  const result: Record<string, { count: string; hash: string }> = {};
  for (const [table, fields] of names) {
    result[table] = (
      await client.query<{
        count: string;
        hash: string;
      }>(`SELECT count(*)::text AS count,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)::text),'')) AS hash
      FROM (SELECT ${fields.map(identifier).join(",")} FROM public.${identifier(table)}) t`)
    ).rows[0]!;
  }
  return result;
}

export async function completionPreflight(client: PoolClient) {
  requireBankingSandbox();
  assert.equal(process.env.QB_BRIDGE_DISABLED, "true");
  assert.equal(process.env.SMTP_DISABLED, "true");
  assert.equal(process.env.BAMS_WEBHOOK_DISABLED, "true");
  assert.equal(process.env.DISABLE_SCHEDULED_JOBS, "true");
  const target = (
    await client.query<{
      database: string;
      read_only: string;
      recovery: boolean;
    }>(`SELECT
    current_database() AS database,current_setting('transaction_read_only') AS read_only,pg_is_in_recovery() AS recovery`)
  ).rows[0]!;
  assert.equal(target.database, "medusa");
  assert.equal(
    target.read_only,
    "on",
    "Preflight must run in a PostgreSQL read-only transaction"
  );
  const discovered = (
    await client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables
    WHERE schemaname='public' ORDER BY tablename`)
  ).rows.map((row) => row.tablename);
  const migrationTables = discovered.filter((table) =>
    table.includes("migration")
  );
  const migrationColumns = await completionColumns(client, migrationTables);
  const migrationTracking = {
    tables: migrationTables,
    columns: migrationColumns,
    fingerprints: await completionTableFingerprints(client, migrationColumns),
    banking_records: migrationTables.includes("mikro_orm_migrations")
      ? (
          await client.query(
            "SELECT id,name,executed_at FROM mikro_orm_migrations WHERE name=ANY($1::text[]) ORDER BY name,id",
            [completionLegacyMigrations]
          )
        ).rows
      : [],
    constraints: (
      await client.query(
        `SELECT c.relname AS table_name,con.conname AS name,
      pg_get_constraintdef(con.oid,true) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])
      ORDER BY c.relname,con.conname`,
        [migrationTables]
      )
    ).rows,
  };
  const bankingFunctions = (
    await client.query(`SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND starts_with(p.proname,'bank_') ORDER BY p.proname,p.oid`)
  ).rows;
  const sandboxAdminExists = Boolean(
    (
      await client.query(
        `SELECT 1 FROM public."user"
    WHERE email=$1 AND deleted_at IS NULL LIMIT 1`,
        ["sandbox@test.com"]
      )
    ).rowCount
  );
  const banking = discovered.filter((table) => table.startsWith("bank_"));
  for (const table of banking)
    assert(
      completionBankCaps[table] !== undefined,
      `Unapproved Banking table: ${table}`
    );
  const prerequisites = [
    "bank_opening_balance",
    "bank_opening_item",
    "bank_opening_clear",
    "bank_receipt_consumption",
  ];
  const missingPrerequisites = prerequisites.filter(
    (table) => !banking.includes(table)
  );
  const sourceTables = Object.keys(completionFixtureCaps).filter((table) =>
    discovered.includes(table)
  );
  const tables = [...new Set([...banking, ...sourceTables])].sort();
  const columns = await completionColumns(client, tables);
  const data = await completionTableFingerprints(client, columns);
  for (const table of banking)
    assert(
      Number(data[table]!.count) <= completionBankCaps[table]!,
      `${table} exceeds approved total cap`
    );
  const owned: Record<string, { count: number; cap: number }> = {};
  for (const table of sourceTables) {
    assert(
      columns.some(
        (column) => column.table_name === table && column.column_name === "id"
      ),
      `${table} needs explicit ownership selector`
    );
    const count = Number(
      (
        await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM public.${identifier(table)}
      WHERE starts_with(id::text,$1) OR starts_with(id::text,'cpay_e2e_receipts_v9_')`,
          [completionPrefix]
        )
      ).rows[0]!.count
    );
    owned[table] = { count, cap: completionFixtureCaps[table]! };
    assert(count <= owned[table]!.cap, `${table} exceeds owned fixture cap`);
  }
  const triggers = (
    await client.query<{
      table_name: string;
      trigger_name: string;
      enabled: string;
      trigger_definition: string;
      function_name: string;
      function_definition: string;
    }>(
      `SELECT c.relname AS table_name,
    t.tgname AS trigger_name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid,true) AS trigger_definition,
    p.proname AS function_name,pg_get_functiondef(p.oid) AS function_definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND c.relname=ANY($1::text[])
    AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
      [tables]
    )
  ).rows;
  assert(
    triggers.every((trigger) => trigger.enabled === "O"),
    "A scoped trigger is disabled or uses unexpected firing mode"
  );
  const foreignKeys = (
    await client.query(
      `SELECT source.relname AS source_table,target.relname AS target_table,
    con.conname AS name,pg_get_constraintdef(con.oid,true) AS definition
    FROM pg_constraint con JOIN pg_class source ON source.oid=con.conrelid
    JOIN pg_class target ON target.oid=con.confrelid WHERE con.contype='f'
    AND (source.relname=ANY($1::text[]) OR target.relname=ANY($1::text[]))
    ORDER BY source.relname,target.relname,con.conname`,
      [tables]
    )
  ).rows;
  const constraints = (
    await client.query(
      `SELECT c.relname AS table_name,con.conname AS name,
    pg_get_constraintdef(con.oid,true) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])
    ORDER BY c.relname,con.conname`,
      [tables]
    )
  ).rows;
  const indexes = (
    await client.query(
      `SELECT tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename,indexname`,
      [tables]
    )
  ).rows;
  const paymentTriggers = triggers.filter(
    (trigger) => trigger.table_name === "customer_payment"
  );
  const orderlessPaymentSafe =
    paymentTriggers.length === 1 &&
    paymentTriggers[0]!.trigger_name === "trg_order_money_payment" &&
    paymentTriggers[0]!.function_definition.includes("WHERE x IS NOT NULL") &&
    columns.some(
      (column) =>
        column.table_name === "customer_payment" &&
        column.column_name === "raw_amount" &&
        column.is_nullable === "NO"
    );
  assert(
    orderlessPaymentSafe,
    "Orderless payment fixture trigger contract changed; review before seeding"
  );
  const schema = { columns, constraints, indexes, triggers, foreignKeys };
  return {
    version: 1,
    scope: "7f96c220",
    target: "localhost:5499/medusa",
    captured_at: new Date().toISOString(),
    read_only: true,
    data,
    protected_data: await fingerprints(client),
    owned,
    schema,
    schema_hash: completionHash(schema),
    missing_prerequisites: missingPrerequisites,
    migration_tracking: migrationTracking,
    banking_functions: bankingFunctions,
    sandbox_admin_exists: sandboxAdminExists,
    admin_prerequisites: await auditCompletionAdmin(client),
    absent_allowed_tables: Object.keys(completionBankCaps).filter(
      (table) => !banking.includes(table)
    ),
    fixture_write_authorization: "NOT_GRANTED_BY_PREFLIGHT",
    closure_review_required: sourceTables.filter(
      (table) => table !== "customer_payment"
    ),
    note: "Catalog includes direct trigger functions and inbound/outbound FKs; transitive function writes require explicit review before source fixtures. Snapshot, migrations and cleanup are separate later actions.",
  };
}
