import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

export const DB = () =>
  new Client({ connectionString: process.env.DATABASE_URL });

// ── Default System Defaults ──────────────────────────────────────────────────
// data_scope: "Customer Data" | "Document Data"
// "Customer Data" = options that describe the customer relationship (terms, etc.)
// "Document Data" = options that appear directly on the printed document header/footer
const DEFAULT_VALUES = [
  // Document Defaults — Payment Terms (was: Terms)
  {
    context: "Document Defaults",
    field_name: "Payment Terms",
    data_scope: "Customer Data",
    value: "Due on Receipt",
    sort_order: 1,
  },
  {
    context: "Document Defaults",
    field_name: "Payment Terms",
    data_scope: "Customer Data",
    value: "30% deposit, 70% upon delivery",
    sort_order: 2,
  },
  {
    context: "Document Defaults",
    field_name: "Payment Terms",
    data_scope: "Customer Data",
    value: "50% deposit, 50% upon delivery",
    sort_order: 3,
  },
  {
    context: "Document Defaults",
    field_name: "Payment Terms",
    data_scope: "Customer Data",
    value: "70% deposit, 30% upon delivery",
    sort_order: 4,
  },
  {
    context: "Document Defaults",
    field_name: "Payment Terms",
    data_scope: "Customer Data",
    value: "80% deposit, 20% upon delivery",
    sort_order: 5,
  },
  {
    context: "Document Defaults",
    field_name: "Payment Terms",
    data_scope: "Customer Data",
    value: "Project Completion",
    sort_order: 6,
  },
  {
    context: "Document Defaults",
    field_name: "Payment Terms",
    data_scope: "Customer Data",
    value: "Net-7",
    sort_order: 7,
  },
  {
    context: "Document Defaults",
    field_name: "Payment Terms",
    data_scope: "Customer Data",
    value: "Net-15",
    sort_order: 8,
  },
  {
    context: "Document Defaults",
    field_name: "Payment Terms",
    data_scope: "Customer Data",
    value: "Net-30",
    sort_order: 9,
  },
  {
    context: "Document Defaults",
    field_name: "Payment Terms",
    data_scope: "Customer Data",
    value: "Special",
    sort_order: 10,
  },
  {
    context: "Document Defaults",
    field_name: "Payment Terms",
    data_scope: "Customer Data",
    value: "Prepaid",
    sort_order: 11,
  },

  // Document Defaults — Tax Code
  {
    context: "Document Defaults",
    field_name: "Tax Code",
    data_scope: "Document Data",
    value: "TAX",
    sort_order: 1,
  },
  {
    context: "Document Defaults",
    field_name: "Tax Code",
    data_scope: "Document Data",
    value: "NON",
    sort_order: 2,
  },

  // Document Defaults — Order Type
  {
    context: "Document Defaults",
    field_name: "Order Type",
    data_scope: "Document Data",
    value: "Standard Order",
    sort_order: 1,
  },
  {
    context: "Document Defaults",
    field_name: "Order Type",
    data_scope: "Document Data",
    value: "Store Pickup",
    sort_order: 2,
  },
  {
    context: "Document Defaults",
    field_name: "Order Type",
    data_scope: "Document Data",
    value: "Project",
    sort_order: 3,
  },

  // Document Defaults — Lead Time
  {
    context: "Document Defaults",
    field_name: "Lead Time",
    data_scope: "Document Data",
    value: "Immediate",
    sort_order: 1,
  },
  {
    context: "Document Defaults",
    field_name: "Lead Time",
    data_scope: "Document Data",
    value: "1-2 Business Days",
    sort_order: 2,
  },
  {
    context: "Document Defaults",
    field_name: "Lead Time",
    data_scope: "Document Data",
    value: "3-5 Business Days",
    sort_order: 3,
  },
  {
    context: "Document Defaults",
    field_name: "Lead Time",
    data_scope: "Document Data",
    value: "5-7 Business Days",
    sort_order: 4,
  },
  {
    context: "Document Defaults",
    field_name: "Lead Time",
    data_scope: "Document Data",
    value: "7-14 Business Days",
    sort_order: 5,
  },

  // Document Defaults — Order Metadata (Customer PO & Project Name)
  {
    context: "Document Defaults",
    field_name: "Customer PO",
    data_scope: "orders",
    value: "-",
    sort_order: 1,
  },
  {
    context: "Document Defaults",
    field_name: "Project Name",
    data_scope: "orders",
    value: "-",
    sort_order: 1,
  },

  // Templates Footer
  {
    context: "Templates Footer",
    field_name: "Draft Order (Estimates)",
    data_scope: "Document Data",
    value: `STORE POLICIES\n·REFUND within 15 days. Product(s) in original condition.\n·EXCHANGE / CREDIT within 30 days. Product(s) in original condition.\n·SPECIAL ORDERS subject to 25% restocking fee.\n·CUSTOM ORDERS not returnable nor cancellable.\n·MADE TO ORDER returns subject to approval, commonly not returnable/cancellable.\n·ECOPOWERTECH not responsible for damages after goods leave our premises.`,
    sort_order: 1,
  },
];

// ── Payment Methods seed ──────────────────────────────────────────────────────
// Each entry: value = internal key, metadata = { display, icon, ledger_method, qb_method }
const PAYMENT_METHODS_SEED = [
  {
    value: "cash",
    sort_order: 1,
    metadata: {
      display: "Cash",
      icon: "💵",
      ledger_method: "cash",
      qb_method: "Cash",
    },
  },
  {
    value: "visa",
    sort_order: 2,
    metadata: {
      display: "Visa",
      icon: "💳",
      ledger_method: "card",
      qb_method: "Visa",
    },
  },
  {
    value: "mastercard",
    sort_order: 3,
    metadata: {
      display: "Mastercard",
      icon: "💳",
      ledger_method: "card",
      qb_method: "MasterCard",
    },
  },
  {
    value: "discover",
    sort_order: 4,
    metadata: {
      display: "Discover",
      icon: "💳",
      ledger_method: "card",
      qb_method: "Discover",
    },
  },
  {
    value: "amex",
    sort_order: 5,
    metadata: {
      display: "American Express",
      icon: "💳",
      ledger_method: "card",
      qb_method: "American Express",
    },
  },
  {
    value: "capital_one",
    sort_order: 6,
    metadata: {
      display: "Capital One",
      icon: "💳",
      ledger_method: "card",
      qb_method: "Capital One",
    },
  },
  {
    value: "debit_card",
    sort_order: 7,
    metadata: {
      display: "Debit Card",
      icon: "🏧",
      ledger_method: "card",
      qb_method: "Debit Card",
    },
  },
  {
    value: "check",
    sort_order: 8,
    metadata: {
      display: "Check",
      icon: "📝",
      ledger_method: "check",
      qb_method: "Check",
    },
  },
  {
    value: "checking_account",
    sort_order: 9,
    metadata: {
      display: "Checking Account",
      icon: "🏦",
      ledger_method: "ach",
      qb_method: "Check",
    },
  },
  {
    value: "money_order",
    sort_order: 10,
    metadata: {
      display: "Money Order",
      icon: "📮",
      ledger_method: "check",
      qb_method: "Check",
    },
  },
  {
    value: "paypal",
    sort_order: 11,
    metadata: {
      display: "PayPal",
      icon: "🅿️",
      ledger_method: "other",
      qb_method: null,
    },
  },
  {
    value: "zelle",
    sort_order: 12,
    metadata: {
      display: "Zelle",
      icon: "⚡",
      ledger_method: "zelle",
      qb_method: "Zelle",
    },
  },
  {
    value: "e_check",
    sort_order: 13,
    metadata: {
      display: "E-Check",
      icon: "📧",
      ledger_method: "ach",
      qb_method: "EFT",
    },
  },
  {
    value: "transfer",
    sort_order: 14,
    metadata: {
      display: "Transfer",
      icon: "🔄",
      ledger_method: "ach",
      qb_method: "EFT",
    },
  },
  {
    value: "wire_transfer",
    sort_order: 15,
    metadata: {
      display: "Wire Transfer",
      icon: "🏦",
      ledger_method: "ach",
      qb_method: "Wire Transfer",
    },
  },
  {
    value: "credit_memo",
    sort_order: 16,
    metadata: {
      display: "Credit Memo",
      icon: "🏷️",
      ledger_method: "credit_memo",
      qb_method: null,
    },
  },
];

// ── Ensure table + seed ────────────────────────────────────────────────────────

export async function ensureTable(client: Client) {
  await client.query(`
        CREATE TABLE IF NOT EXISTS system_defaults (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            context     TEXT NOT NULL,
            field_name  TEXT NOT NULL,
            value       TEXT NOT NULL,
            sort_order  INT  NOT NULL DEFAULT 0,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(context, field_name, value)
        )
    `);

  // Migration: add data_scope column if it doesn't exist yet
  await client.query(`
        ALTER TABLE system_defaults
        ADD COLUMN IF NOT EXISTS data_scope TEXT NOT NULL DEFAULT 'Document Data'
    `);

  // Migration: add metadata column if it doesn't exist yet
  await client.query(`
        ALTER TABLE system_defaults
        ADD COLUMN IF NOT EXISTS metadata JSONB NULL
    `);

  // Migration: consolidate old Customer Defaults / Order Defaults contexts
  try {
    await client.query(`
            UPDATE system_defaults
            SET context = 'Document Defaults'
            WHERE context IN ('Customer Defaults', 'Order Defaults')
            AND NOT EXISTS (
                SELECT 1 FROM system_defaults sd2
                WHERE sd2.context = 'Document Defaults'
                AND sd2.field_name = system_defaults.field_name
                AND sd2.value = system_defaults.value
            )
        `);
    await client.query(`
            DELETE FROM system_defaults WHERE context IN ('Customer Defaults', 'Order Defaults')
        `);
  } catch (e) {
    // ignore unique constraint errors from migration
  }

  // Migration: rename "Terms" → "Payment Terms" and set correct scope
  try {
    // Rename field_name where no conflict exists with existing Payment Terms rows
    await client.query(`
            UPDATE system_defaults
            SET field_name = 'Payment Terms',
                data_scope = 'customers,orders',
                updated_at  = NOW()
            WHERE field_name = 'Terms'
            AND NOT EXISTS (
                SELECT 1 FROM system_defaults sd2
                WHERE sd2.context     = system_defaults.context
                AND   sd2.field_name  = 'Payment Terms'
                AND   sd2.value       = system_defaults.value
            )
        `);
    // Delete any remaining "Terms" rows that are now duplicates of "Payment Terms"
    await client.query(`
            DELETE FROM system_defaults
            WHERE field_name = 'Terms'
        `);
    // Fix any Payment Terms rows that still have old-format scope
    await client.query(`
            UPDATE system_defaults
            SET data_scope = 'customers,orders', updated_at = NOW()
            WHERE field_name = 'Payment Terms'
            AND (data_scope IS NULL OR data_scope IN ('Customer Data', 'Document Data', ''))
        `);
  } catch (e) {
    // ignore errors if already migrated
  }

  // Migration: convert all remaining old-format data_scope values to new format
  //   "Document Data" → "orders"      (fields that appear on docs: Lead Time, Tax Code, etc.)
  //   "Customer Data" → "customers,orders"  (Customer-linked fields: Terms, etc.)
  try {
    await client.query(`
            UPDATE system_defaults SET data_scope = 'orders', updated_at = NOW()
            WHERE data_scope = 'Document Data'
        `);
    await client.query(`
            UPDATE system_defaults SET data_scope = 'customers,orders', updated_at = NOW()
            WHERE data_scope = 'Customer Data'
        `);
  } catch (e) {
    // ignore
  }

  // Migration: insert Customer PO and Project Name placeholders if they don't exist
  try {
    await client.query(`
            INSERT INTO system_defaults (context, field_name, value, sort_order, data_scope)
            VALUES ('Document Defaults', 'Customer PO', '-', 1, 'orders')
            ON CONFLICT DO NOTHING
        `);
    await client.query(`
            INSERT INTO system_defaults (context, field_name, value, sort_order, data_scope)
            VALUES ('Document Defaults', 'Project Name', '-', 1, 'orders')
            ON CONFLICT DO NOTHING
        `);
  } catch (e) {
    // ignore errors
  }

  // Migration: rename "Estimate Status" → "Order Status"
  try {
    await client.query(`
            UPDATE system_defaults
            SET field_name = 'Order Status', updated_at = NOW()
            WHERE field_name = 'Estimate Status'
            AND NOT EXISTS (
                SELECT 1 FROM system_defaults sd2
                WHERE sd2.context    = system_defaults.context
                AND   sd2.field_name = 'Order Status'
                AND   sd2.value      = system_defaults.value
            )
        `);
    // Remove any duplicates that couldn't be renamed due to conflicts
    await client.query(`
            DELETE FROM system_defaults
            WHERE field_name = 'Estimate Status'
        `);
  } catch (e) {
    // ignore errors if already migrated
  }

  const { rowCount } = await client.query(
    "SELECT 1 FROM system_defaults LIMIT 1"
  );
  if (!rowCount) {
    // Single batch INSERT for seeding (includes data_scope)
    const values: any[] = [];
    const placeholders = DEFAULT_VALUES.map((p, i) => {
      const base = i * 5;
      values.push(p.context, p.field_name, p.value, p.sort_order, p.data_scope);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });
    await client.query(
      `INSERT INTO system_defaults (context, field_name, value, sort_order, data_scope)
             VALUES ${placeholders.join(", ")} ON CONFLICT DO NOTHING`,
      values
    );
  }

  // Seed payment methods (idempotent — ON CONFLICT skips existing rows so user edits are preserved)
  try {
    for (const pm of PAYMENT_METHODS_SEED) {
      await client.query(
        `INSERT INTO system_defaults (context, field_name, value, sort_order, data_scope, metadata)
                 VALUES ('Payment Methods', 'Payment Method', $1, $2, 'pos', $3)
                 ON CONFLICT (context, field_name, value) DO NOTHING`,
        [pm.value, pm.sort_order, JSON.stringify(pm.metadata)]
      );
    }
  } catch (e) {
    // ignore seed errors — non-fatal
  }
}

/**
 * GET /admin/system-defaults
 * Returns all defaults ordered by context, field_name, sort_order
 */
export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const client = DB();
  try {
    await client.connect();
    await ensureTable(client);
    const { rows } = await client.query(
      `SELECT * FROM system_defaults ORDER BY context, field_name, sort_order, value`
    );
    res.json({ defaults: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  } finally {
    await client.end();
  }
}

/**
 * POST /admin/system-defaults
 * Creates a new system default value
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const {
    context,
    field_name,
    value,
    sort_order = 0,
    data_scope,
    metadata,
  } = req.body as any;
  if (!context || !field_name || !value) {
    res
      .status(400)
      .json({ error: "context, field_name, and value are required" });
    return;
  }
  const client = DB();
  try {
    await client.connect();
    await ensureTable(client);
    const { rows } = await client.query(
      `INSERT INTO system_defaults (context, field_name, value, sort_order, data_scope, metadata)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        context,
        field_name,
        value,
        sort_order,
        data_scope ?? "orders",
        metadata != null ? JSON.stringify(metadata) : null,
      ]
    );
    res.status(201).json({ default: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  } finally {
    await client.end();
  }
}
