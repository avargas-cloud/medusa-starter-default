/**
 * src/scripts/fix/write-off-ap-rounding.ts — ap-rounding-cleanup-20260916
 *
 * One-time cleanup of the cents the POS still shows as owed (or overpaid) on
 * bills QuickBooks already has PAID: one `vendor_bill_adjustment kind=rounding`
 * per bill, dated at the ledger cutover, posted to the GL. Nothing goes to QB.
 *
 * Also `configure`: writes the lane's accounts/tolerance into `store.metadata`
 * (merge, never replace — `updateStores` would wipe the PIN).
 *
 *   DRY RUN (default):
 *     env DATABASE_URL=… npx medusa exec ./src/scripts/fix/write-off-ap-rounding.ts
 *   APPLY:
 *     APPLY=true AP_ADJUST_DATE=2026-09-12 … medusa exec …
 *   CONFIGURE:
 *     AP_CONFIGURE=1 AP_ROUNDING_ACCOUNT=<ListID> AP_VARIANCE_ACCOUNT=<ListID> AP_TOLERANCE_CENTS=50 … medusa exec …
 *   PRICE VARIANCE (ADI GLOBAL: the QB bill is for LESS than the PO price the POS billed):
 *     AP_PRICE_VARIANCE=1 [APPLY=true] … medusa exec …
 *     Only with QB evidence (`data/ap-rounding-cleanup-20260916-qb-evidence.json`,
 *     BillQuery of 09/16/2026): the bill is IsPaid in QB AND its QB AmountDue equals
 *     what the POS already paid/credited — so the residual is exactly POS payable −
 *     QB total, a price difference, never a missing payment.
 *
 * Idempotent: fingerprint `cleanup-20260916:<residual>` per bill; a second run
 * finds the rows and creates nothing. Only bills with `qb_is_paid = true` and
 * |residual| ≤ tolerance qualify — anything bigger is NOT rounding and stays
 * open on purpose (price variance / missing payment: other scripts).
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { computeBillBalancesBatch } from "../../lib/finance/recompute-bill-finance";
import { postVendorBillAdjustment } from "../../lib/ledger/documents/vendor-bill-adjustment";
import {
  AP_ADJUSTMENT_CONFIG_KEYS,
  loadApAdjustmentConfig,
  parseTolerance,
} from "../../lib/vendor-bill-adjustments/config";
import { createVendorBillAdjustment } from "../../lib/vendor-bill-adjustments/create";

import fs from "node:fs";
import path from "node:path";

const APPLY = process.env.APPLY === "true";
const PRICE_VARIANCE = process.env.AP_PRICE_VARIANCE === "1";
const EVIDENCE_PATH =
  process.env.AP_QB_EVIDENCE ??
  path.join(__dirname, "data", "ap-rounding-cleanup-20260916-qb-evidence.json");

type QbEvidence = Record<
  string,
  {
    amount_due_cents: number;
    is_paid: boolean;
    ref: string | null;
    checked_at: string;
  }
>;

function loadEvidence(): QbEvidence {
  const raw = fs.readFileSync(EVIDENCE_PATH, "utf8");
  return JSON.parse(raw) as QbEvidence;
}
const ADJUST_DATE = process.env.AP_ADJUST_DATE ?? "2026-09-12";
const ACTOR = "script:write-off-ap-rounding";
const FINGERPRINT_PREFIX = "cleanup-20260916";

async function configure(
  client: PoolClient,
  say: (m: string) => void
): Promise<void> {
  const rounding = process.env.AP_ROUNDING_ACCOUNT?.trim();
  const variance = process.env.AP_VARIANCE_ACCOUNT?.trim();
  const tolerance = parseTolerance(process.env.AP_TOLERANCE_CENTS);
  const patch: Record<string, string> = {};
  for (const [key, listId] of [
    [AP_ADJUSTMENT_CONFIG_KEYS.rounding, rounding],
    [AP_ADJUSTMENT_CONFIG_KEYS.priceVariance, variance],
  ] as const) {
    if (!listId) continue;
    const { rows } = await client.query(
      `SELECT name, account_type FROM qb_account WHERE qb_list_id = $1 AND is_active = true`,
      [listId]
    );
    if (!rows[0])
      throw new Error(`${key}: ${listId} is not an active qb_account`);
    say(
      `${key} → ${listId} (${(rows[0] as { name: string; account_type: string }).name}, ${(rows[0] as { account_type: string }).account_type})`
    );
    patch[key] = listId;
  }
  patch[AP_ADJUSTMENT_CONFIG_KEYS.tolerance] = String(tolerance);
  say(`${AP_ADJUSTMENT_CONFIG_KEYS.tolerance} → ${tolerance}`);
  if (!APPLY)
    return say("dry-run: store.metadata NOT written (APPLY=true to write)");
  // Merge in Postgres: `metadata || jsonb` never touches the other keys.
  await client.query(
    `UPDATE store SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb`,
    [JSON.stringify(patch)]
  );
  say("store.metadata updated (merge)");
}

async function priceVariance(
  client: PoolClient,
  say: (m: string) => void,
  bills: Array<{
    id: string;
    number: string | null;
    vendor: string | null;
    qb_txn_id: string | null;
  }>,
  balances: Awaited<ReturnType<typeof computeBillBalancesBatch>>,
  accountListId: string | null,
  toleranceCents: number
): Promise<void> {
  if (!accountListId)
    return say(
      "ABORT: configure the price-variance account first (AP_CONFIGURE=1)."
    );
  const evidence = loadEvidence();
  say(`evidence: ${Object.keys(evidence).length} bills (${EVIDENCE_PATH})`);
  const candidates: Array<{
    id: string;
    number: string | null;
    vendor: string | null;
    residual: number;
    qb_due: number;
    qb_txn_id: string;
  }> = [];
  const rejected: string[] = [];
  for (const b of bills) {
    const bal = balances.get(b.id);
    if (
      !bal ||
      bal.balance_cents === 0 ||
      Math.abs(bal.balance_cents) <= toleranceCents
    )
      continue;
    const ev = b.qb_txn_id ? evidence[b.qb_txn_id] : undefined;
    if (!ev) {
      rejected.push(`${b.number ?? b.id}: no QB evidence`);
      continue;
    }
    const settled = bal.paid_cents + bal.credited_cents + bal.adjusted_cents;
    if (!ev.is_paid || ev.amount_due_cents !== settled) {
      rejected.push(
        `${b.number ?? b.id}: QB due ${ev.amount_due_cents}¢ ≠ settled ${settled}¢ (is_paid=${ev.is_paid}) — not a price variance`
      );
      continue;
    }
    candidates.push({
      id: b.id,
      number: b.number,
      vendor: b.vendor,
      residual: bal.balance_cents,
      qb_due: ev.amount_due_cents,
      qb_txn_id: b.qb_txn_id!,
    });
  }
  say(
    `price-variance candidates: ${candidates.length} · sum ${candidates.reduce((s, c) => s + c.residual, 0)}¢`
  );
  for (const c of candidates)
    say(
      `  ${(c.number ?? c.id).padEnd(12)} ${(c.vendor ?? "").slice(0, 24).padEnd(24)} POS payable − QB ${String(c.residual).padStart(7)}¢  (QB due ${c.qb_due}¢)`
    );
  say(`rejected: ${rejected.length}`);
  for (const r of rejected) say(`  ⏭ ${r}`);
  if (!APPLY) return;
  let created = 0;
  let posted = 0;
  for (const c of candidates) {
    await client.query("BEGIN");
    try {
      const result = await createVendorBillAdjustment(client, {
        vendor_bill_id: c.id,
        kind: "price_variance",
        residual_cents: c.residual,
        adjustment_date: ADJUST_DATE,
        source_fingerprint: `${FINGERPRINT_PREFIX}:qb:${c.qb_txn_id}:${c.qb_due}`,
        evidence: {
          qb_txn_id: c.qb_txn_id,
          qb_amount_due_cents: c.qb_due,
          qb_is_paid: true,
          qb: "not_required_already_correct",
          script: "write-off-ap-rounding:price-variance",
        },
        memo: "Price variance — QuickBooks bill is for the vendor's invoiced amount (ap-rounding-cleanup-20260916)",
        actor_id: ACTOR,
        ignore_tolerance: true,
      });
      await client.query("COMMIT");
      if (result.created) created++;
      await client.query("BEGIN");
      const gl = await postVendorBillAdjustment(
        client,
        result.adjustment.id,
        ACTOR
      );
      await client.query("COMMIT");
      if (gl.status === "posted") posted++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      say(
        `  ✗ ${c.number ?? c.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  say(`done: ${created} created · ${posted} GL entries posted`);
  const after = await computeBillBalancesBatch(
    client,
    candidates.map((c) => c.id)
  );
  const still = candidates.filter(
    (c) => (after.get(c.id)?.balance_cents ?? 0) !== 0
  );
  say(
    still.length === 0
      ? "readback OK: all candidates at 0"
      : `readback: ${still.length} still open — ${still.map((s) => s.number ?? s.id).join(", ")}`
  );
}

export default async function main({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const say = (m: string) => logger.info(`[ap-rounding] ${m}`);
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    if (process.env.AP_CONFIGURE === "1") {
      await configure(client, say);
      return;
    }
    say(
      APPLY
        ? `APPLY — adjustments dated ${ADJUST_DATE}`
        : "DRY RUN — nothing is written"
    );
    const config = await loadApAdjustmentConfig(client);
    say(
      `tolerance ${config.toleranceCents}¢ · rounding account ${config.roundingAccountListId ?? "NOT CONFIGURED"}`
    );
    if (!config.roundingAccountListId) {
      say("ABORT: configure the rounding account first (AP_CONFIGURE=1).");
      return;
    }

    const { rows: bills } = await client.query<{
      id: string;
      number: string | null;
      vendor: string | null;
      qb_txn_id: string | null;
    }>(
      `SELECT id, number, vendor_name_snapshot AS vendor, qb_txn_id FROM vendor_bill
        WHERE deleted_at IS NULL AND status IN ('confirmed','synced') AND qb_is_paid = true`
    );
    const balances = await computeBillBalancesBatch(
      client,
      bills.map((b) => b.id)
    );
    if (PRICE_VARIANCE) {
      await priceVariance(
        client,
        say,
        bills,
        balances,
        config.priceVarianceAccountListId,
        config.toleranceCents
      );
      return;
    }
    const candidates = bills
      .map((b) => ({ ...b, residual: balances.get(b.id)?.balance_cents ?? 0 }))
      .filter(
        (b) => b.residual !== 0 && Math.abs(b.residual) <= config.toleranceCents
      )
      .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
    const skipped = bills
      .map((b) => ({ ...b, residual: balances.get(b.id)?.balance_cents ?? 0 }))
      .filter((b) => Math.abs(b.residual) > config.toleranceCents);

    const positive = candidates.filter((c) => c.residual > 0);
    const negative = candidates.filter((c) => c.residual < 0);
    say(
      `candidates: ${candidates.length} (owed ${positive.length} = ${positive.reduce((s, c) => s + c.residual, 0)}¢ · overpaid ${negative.length} = ${negative.reduce((s, c) => s + c.residual, 0)}¢)`
    );
    for (const c of candidates)
      say(
        `  ${(c.number ?? c.id).padEnd(12)} ${(c.vendor ?? "").slice(0, 28).padEnd(28)} ${String(c.residual).padStart(6)}¢`
      );
    say(`above tolerance (NOT touched, other lanes): ${skipped.length}`);
    for (const s of skipped)
      say(
        `  ${(s.number ?? s.id).padEnd(12)} ${(s.vendor ?? "").slice(0, 28).padEnd(28)} ${String(s.residual).padStart(8)}¢`
      );
    if (!APPLY) return;

    let created = 0;
    let existing = 0;
    let posted = 0;
    for (const c of candidates) {
      await client.query("BEGIN");
      try {
        const result = await createVendorBillAdjustment(client, {
          vendor_bill_id: c.id,
          kind: "rounding",
          residual_cents: c.residual,
          adjustment_date: ADJUST_DATE,
          source_fingerprint: `${FINGERPRINT_PREFIX}:${c.residual}`,
          evidence: {
            qb_is_paid: true,
            qb_txn_id: c.qb_txn_id,
            qb: "not_required_already_correct",
            script: "write-off-ap-rounding",
          },
          memo: "Rounding write-off — QuickBooks has this bill paid (ap-rounding-cleanup-20260916)",
          actor_id: ACTOR,
        });
        await client.query("COMMIT");
        if (result.created) created++;
        else existing++;
        // GL post in its own transaction (idempotent: already_posted on re-run).
        await client.query("BEGIN");
        const gl = await postVendorBillAdjustment(
          client,
          result.adjustment.id,
          ACTOR
        );
        await client.query("COMMIT");
        if (gl.status === "posted") posted++;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        say(
          `  ✗ ${c.number ?? c.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    say(
      `done: ${created} created · ${existing} already existed · ${posted} GL entries posted`
    );

    // Readback: every candidate must now balance to 0.
    const after = await computeBillBalancesBatch(
      client,
      candidates.map((c) => c.id)
    );
    const still = candidates.filter(
      (c) => (after.get(c.id)?.balance_cents ?? 0) !== 0
    );
    say(
      still.length === 0
        ? "readback OK: all candidates at 0"
        : `readback: ${still.length} still open — ${still.map((s) => s.number ?? s.id).join(", ")}`
    );
  } finally {
    client.release();
  }
}
