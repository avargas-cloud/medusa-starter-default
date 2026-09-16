/**
 * src/scripts/fix/adopt-qb-vendor-credits.ts — ap-rounding-cleanup-20260916 (C2 + D)
 *
 * Three VendorCredits exist in QuickBooks, applied to bills the POS still
 * shows open, and never reached the POS (BillQuery + VendorCreditQuery of
 * 09/16/2026, `qb-query`). This adopts them: `vendor_credit` (posted, the QB
 * TxnID as `qb_txn_id`, lines mirrored from QB) + the application to the
 * bill (`vendor_credit_application` with the QB TxnIDs) + the GL post of the
 * credit (Dr AP / Cr Inventory Asset / Restocking Fees). Nothing is sent to
 * QuickBooks and NO stock moves: the returns happened months ago
 * (`stock_applied_at` stays NULL on purpose — ATAJO: adopted document, the
 * physical return is not replayed).
 *
 * Also (D): Legrand VB-1081 / VB-1083 carry `qb_is_paid = true` while QB has
 * them `IsPaid = false` — the flag is corrected, the bills stay open.
 *
 * 2025 rule: credit 047501 is dated 2025-09-22 in QB; the POS ledger is
 * closed for 2025, so its POS `credit_date` is 2026-01-01 (memo keeps the QB
 * date). Idempotent by `qb_txn_id`. DRY RUN by default; `APPLY=true` writes.
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { generateEntityId } from "@medusajs/utils";
import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { computeBillBalance } from "../../lib/finance/recompute-bill-finance";
import { postVendorCredit } from "../../lib/ledger/documents/vendor-credit";
import { nextVendorCreditNumber } from "../../lib/vendor-credits/numbering";

const APPLY = process.env.APPLY === "true";
const ACTOR = "script:adopt-qb-vendor-credits";

type Line =
  | {
      line_type: "product";
      sku: string;
      description: string;
      qty: number;
      unit_cost_cents: number;
      amount_cents: number;
    }
  | {
      line_type: "qb_account";
      description: string;
      qb_account_list_id: string;
      amount_cents: number;
    };

interface Adoption {
  qb_txn_id: string;
  qb_ref: string;
  qb_date: string;
  pos_credit_date: string;
  vendor_qb_list_id: string;
  total_cents: number;
  reason: string;
  memo: string;
  bill_qb_txn_id: string;
  lines: Line[];
}

const ADOPTIONS: Adoption[] = [
  {
    qb_txn_id: "1C6C30-1780689299",
    qb_ref: "726069",
    qb_date: "2026-06-05",
    pos_credit_date: "2026-06-05",
    vendor_qb_list_id: "8000008B-1353435045", // SATCO PRODUCTS, INC
    total_cents: 41600,
    reason: "Return",
    memo: "RA 879907-00 — adopted from QuickBooks VendorCredit 726069 (ap-rounding-cleanup-20260916)",
    bill_qb_txn_id: "1C6B6C-1780681698",
    lines: [
      {
        line_type: "product",
        sku: "SAT-65-571R1",
        description: "LED Panel, 2x2FT, 120-277V, Power Select",
        qty: 16,
        unit_cost_cents: 2600,
        amount_cents: 41600,
      },
    ],
  },
  {
    qb_txn_id: "1B4ACE-1768862926",
    qb_ref: "055663",
    qb_date: "2026-01-19",
    pos_credit_date: "2026-01-19",
    vendor_qb_list_id: "80001C76-1672937454", // Goodlite
    total_cents: 23160,
    reason: "Return",
    memo: "SH041144 — adopted from QuickBooks VendorCredit 055663 (ap-rounding-cleanup-20260916)",
    bill_qb_txn_id: "1B2ED1-1767705584", // VB-0209
    // ATAJO: `chk_vcl_amount` forbids negative lines, so the 20 % restocking fee
    // (−57.90) is netted into the product lines (289.50 → 231.60) instead of a
    // Restocking Fees expense line; disparador: a vendor credit editor that
    // models fees as their own line type.
    lines: [
      {
        line_type: "product",
        sku: "GL-G-10220",
        description:
          "ASTER 4 INCH White Square Trim Kit (net of 20% restocking fee)",
        qty: 22,
        unit_cost_cents: 625,
        amount_cents: 11000,
      },
      {
        line_type: "product",
        sku: "GL-G-48339",
        description:
          "LED RETROFIT UNITS ROUND 5 & 6, Selecta (net of 20% restocking fee)",
        qty: 8,
        unit_cost_cents: 1900,
        amount_cents: 12160,
      },
    ],
  },
  {
    qb_txn_id: "1A7B50-1759945292",
    qb_ref: "047501",
    qb_date: "2025-09-22",
    pos_credit_date: "2026-01-01", // 2025 is closed in the POS ledger
    vendor_qb_list_id: "80001C76-1672937454", // Goodlite
    total_cents: 20160,
    reason: "Return",
    memo: "Adopted from QuickBooks VendorCredit 047501 dated 2025-09-22 (2025 closed → posted 2026-01-01) (ap-rounding-cleanup-20260916)",
    bill_qb_txn_id: "1AB5FA-1761664551", // VB-0223
    lines: [
      {
        line_type: "product",
        sku: "GL-G-20092",
        description:
          "LED 4 Regress Gimbal Square, Selectable (net of 20% restocking fee)",
        qty: 6,
        unit_cost_cents: 4200,
        amount_cents: 20160,
      },
    ],
  },
];

/** QB `IsPaid=false` on 09/16/2026 — the POS flag was stale. */
const STALE_PAID_FLAG_BILL_TXN_IDS = ["1CC372-1785880774", "1CC6C6-1786037760"]; // Legrand VB-1081, VB-1083

export default async function main({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const say = (m: string) => logger.info(`[adopt-vc] ${m}`);
  const client: PoolClient = await getDbPool().connect();
  try {
    say(APPLY ? "APPLY" : "DRY RUN — nothing is written");
    for (const a of ADOPTIONS) {
      const sum = a.lines.reduce((s, l) => s + l.amount_cents, 0);
      if (sum !== a.total_cents)
        throw new Error(
          `${a.qb_ref}: lines sum ${sum} ≠ total ${a.total_cents}`
        );
      const { rows: vendors } = await client.query<{
        id: string;
        full_name: string;
      }>(
        `SELECT id, full_name FROM qb_vendor WHERE qb_list_id = $1 AND deleted_at IS NULL`,
        [a.vendor_qb_list_id]
      );
      const vendor = vendors[0];
      if (!vendor)
        throw new Error(
          `${a.qb_ref}: vendor ${a.vendor_qb_list_id} not in qb_vendor`
        );
      const { rows: bills } = await client.query<{
        id: string;
        number: string | null;
      }>(
        `SELECT id, number FROM vendor_bill WHERE qb_txn_id = $1 AND deleted_at IS NULL`,
        [a.bill_qb_txn_id]
      );
      const bill = bills[0];
      if (!bill)
        throw new Error(
          `${a.qb_ref}: bill ${a.bill_qb_txn_id} not in vendor_bill`
        );
      const before = await computeBillBalance(client, bill.id);
      const { rows: existing } = await client.query<{
        id: string;
        number: string | null;
      }>(
        `SELECT id, number FROM vendor_credit WHERE qb_txn_id = $1 AND deleted_at IS NULL`,
        [a.qb_txn_id]
      );
      say(
        `${a.qb_ref} ${vendor.full_name} $${(a.total_cents / 100).toFixed(2)} → bill ${bill.number ?? bill.id} (balance now ${before?.balance_cents ?? "?"}¢)${existing[0] ? ` — already adopted as ${existing[0].number}` : ""}`
      );
      if (!APPLY || existing[0]) continue;

      await client.query("BEGIN");
      try {
        const creditId = generateEntityId("", "vcr");
        const number = await nextVendorCreditNumber(client);
        await client.query(
          `INSERT INTO vendor_credit
             (id, number, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot, credit_date, reason, memo,
              status, total_cents, applied_cents, qb_txn_id, qb_synced_at, posted_at, posted_by, vendor_bill_id)
           VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,'posted',$9,$9,$10,now(),now(),$11,$12)`,
          [
            creditId,
            number,
            vendor.id,
            vendor.full_name,
            a.vendor_qb_list_id,
            a.pos_credit_date,
            a.reason,
            a.memo,
            a.total_cents,
            a.qb_txn_id,
            ACTOR,
            bill.id,
          ]
        );
        let sort = 0;
        for (const l of a.lines) {
          sort++;
          if (l.line_type === "product") {
            await client.query(
              `INSERT INTO vendor_credit_line (id, credit_id, sort, line_type, sku, description, qty, unit_cost_cents, amount_cents)
               VALUES ($1,$2,$3,'product',$4,$5,$6,$7,$8)`,
              [
                generateEntityId("", "vcl"),
                creditId,
                sort,
                l.sku,
                l.description,
                l.qty,
                l.unit_cost_cents,
                l.amount_cents,
              ]
            );
          } else {
            const { rows: acc } = await client.query<{
              name: string;
              account_type: string;
            }>(
              `SELECT name, account_type FROM qb_account WHERE qb_list_id = $1 AND is_active = true`,
              [l.qb_account_list_id]
            );
            if (!acc[0])
              throw new Error(`account ${l.qb_account_list_id} missing`);
            await client.query(
              `INSERT INTO vendor_credit_line (id, credit_id, sort, line_type, description, qb_account_list_id, qb_account_full_name, qb_account_type, amount_cents)
               VALUES ($1,$2,$3,'qb_account',$4,$5,$6,$7,$8)`,
              [
                generateEntityId("", "vcl"),
                creditId,
                sort,
                l.description,
                l.qb_account_list_id,
                acc[0].name,
                acc[0].account_type,
                l.amount_cents,
              ]
            );
          }
        }
        await client.query(
          `INSERT INTO vendor_credit_application
             (id, credit_id, vendor_bill_id, amount_cents, applied_at, applied_by, qb_applied_at, qb_bill_txn_id, qb_credit_txn_id)
           VALUES ($1,$2,$3,$4,$5::date,$6,$5::date,$7,$8)`,
          [
            generateEntityId("", "vcap"),
            creditId,
            bill.id,
            a.total_cents,
            a.pos_credit_date,
            ACTOR,
            a.bill_qb_txn_id,
            a.qb_txn_id,
          ]
        );
        const gl = await postVendorCredit(client, creditId, ACTOR);
        await client.query("COMMIT");
        const after = await computeBillBalance(client, bill.id);
        say(
          `  ✓ ${number} adopted · GL ${gl.status} · bill balance ${before?.balance_cents}¢ → ${after?.balance_cents}¢`
        );
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        say(
          `  ✗ ${a.qb_ref}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const { rows: stale } = await client.query<{
      number: string | null;
      qb_is_paid: boolean;
    }>(
      `SELECT number, qb_is_paid FROM vendor_bill WHERE qb_txn_id = ANY($1::text[]) AND deleted_at IS NULL`,
      [STALE_PAID_FLAG_BILL_TXN_IDS]
    );
    say(
      `stale qb_is_paid (QB says open): ${stale.map((s) => `${s.number}=${s.qb_is_paid}`).join(", ")}`
    );
    if (APPLY) {
      const { rowCount } = await client.query(
        `UPDATE vendor_bill SET qb_is_paid = false, updated_at = now()
          WHERE qb_txn_id = ANY($1::text[]) AND deleted_at IS NULL AND qb_is_paid = true`,
        [STALE_PAID_FLAG_BILL_TXN_IDS]
      );
      say(`  ✓ qb_is_paid corrected on ${rowCount ?? 0} bill(s)`);
    }
  } finally {
    client.release();
  }
}
