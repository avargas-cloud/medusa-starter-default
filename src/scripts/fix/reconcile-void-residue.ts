/**
 * reconcile-void-residue.ts  (Phase A — payment ledger reconciliation)
 *
 * Fixes the historical VOID RESIDUE: orders whose invoice was voided but whose
 * native Medusa payment_collection kept a captured amount that was never
 * refunded (root cause fixed going-forward in commit 855396de). The native
 * ledger over-states captured money vs the finance ledger.
 *
 * For each order that (a) has at least one VOIDED invoice and (b) shows native
 * effective captured > expected-native, we refund the residue natively via
 * refundPayment() so native effective captured == expected-native.
 *
 *   expected_native_cents = Σ ACTIVE (non-voided) payment_application.amount_applied
 *                           for the order, joined to customer_payment, EXCLUDING
 *                           credit_memo type/method (those intentionally never
 *                           create a native capture).
 *   native_effective_cents = round((Σ captured − Σ refunded) × 100) over the
 *                            order's pp_system_default payments.
 *   residue = native_effective_cents − expected_native_cents  (refund if > 1¢)
 *
 * Guardrails (per Codex review):
 *   - DRY_RUN by default; set APPLY=true to actually refund.
 *   - Restricted to orders WITH a voided invoice (excludes the deposit
 *     double-capture set B, whose orders have no voided invoice).
 *   - Only refunds provider_id = 'pp_system_default' (system, no real money /
 *     no gateway). Never touches Authorize.Net / web payments.
 *   - Integer cents for all decisions; dollars only at refundPayment().
 *   - Processes newest captures first; refunds only the current positive diff,
 *     chunked by refundable capture rows; never over-refunds a payment.
 *   - Idempotent: recomputes live per order and skips when |residue| ≤ 1¢.
 *   - After each order, requeries and asserts native_effective == expected.
 *
 * Usage:
 *   cd backend
 *   yarn medusa exec ./src/scripts/fix/reconcile-void-residue.ts            # DRY RUN
 *   APPLY=true yarn medusa exec ./src/scripts/fix/reconcile-void-residue.ts # APPLY
 */

import { MedusaContainer } from "@medusajs/framework/types";

const APPLY = process.env.APPLY === "true";
const SYSTEM_PROVIDER = "pp_system_default";
const TOLERANCE_CENTS = 1;

type PaymentRow = {
  id: string;
  provider_id: string | null;
  captured_cents: number;
  refunded_cents: number;
  available_cents: number;
  newest_capture_at: number; // ms, for newest-first ordering
};

function toCents(n: unknown): number {
  return Math.round(Number(n ?? 0) * 100);
}

export default async function reconcileVoidResidue({
  container,
}: {
  container: MedusaContainer;
}) {
  const query = container.resolve("query") as any;
  const paymentModule = container.resolve("payment") as any;
  const knex = container.resolve("__pg_connection__") as any;

  console.log(
    `\n[reconcile-void-residue] mode=${APPLY ? "APPLY" : "DRY_RUN"}\n`
  );

  // 1. Candidate A-set: orders with a VOIDED invoice AND native_eff > expected_native.
  const { rows: candidates } = await knex.raw(
    `
    WITH nat AS (
      SELECT opc.order_id,
             ROUND((SUM(pc.captured_amount) - SUM(COALESCE(pc.refunded_amount,0))) * 100)::bigint AS native_eff
      FROM order_payment_collection opc
      JOIN payment_collection pc ON pc.id = opc.payment_collection_id
      GROUP BY opc.order_id
    ),
    expct AS (
      -- Expected native = ALL active (non-voided) applications. We do NOT exclude
      -- credit_memo/store-credit: contrary to the assumption that they skip native
      -- capture, sandbox testing found credit_memo payments that DO create a native
      -- capture (e.g. order 1461: $96.17 CM captured natively). Excluding them
      -- produced a FALSE residue and would have refunded an aligned order. If a CM
      -- genuinely did NOT capture natively, expected > native → negative residue →
      -- not refunded here (correctly left to Phase C).
      SELECT pa.order_id, COALESCE(SUM(pa.amount_applied),0)::bigint AS exp_native
      FROM payment_application pa
      JOIN customer_payment cp ON cp.id = pa.payment_id AND cp.deleted_at IS NULL
      WHERE pa.voided_at IS NULL AND pa.deleted_at IS NULL
      GROUP BY pa.order_id
    ),
    voided_inv AS (
      SELECT DISTINCT order_id FROM pos_invoice WHERE status = 'voided'
    )
    SELECT n.order_id,
           o.display_id,
           n.native_eff,
           COALESCE(e.exp_native,0) AS exp_native,
           (n.native_eff - COALESCE(e.exp_native,0)) AS residue
    FROM nat n
    JOIN "order" o ON o.id = n.order_id
    JOIN voided_inv vi ON vi.order_id = n.order_id
    LEFT JOIN expct e ON e.order_id = n.order_id
    WHERE (n.native_eff - COALESCE(e.exp_native,0)) > ?
    ORDER BY residue DESC
    `,
    [TOLERANCE_CENTS]
  );

  console.log(
    `[reconcile-void-residue] ${candidates.length} candidate order(s) (voided invoice + native residue)\n`
  );

  let totalRefundedCents = 0;
  let okCount = 0;
  let skipCount = 0;
  const failures: string[] = [];

  for (const c of candidates) {
    const orderId: string = c.order_id;
    const displayId = c.display_id;
    const tag = `#${displayId}`;

    // Advisory lock per order to avoid racing a live POS mutation.
    await knex.raw(`SELECT pg_advisory_lock(hashtext(?))`, [orderId]);
    try {
      // 2. Recompute LIVE (idempotent) from the native ledger + finance apps.
      const payments = await loadNativePayments(query, orderId);
      const nativeEff = payments.reduce((s, p) => s + p.available_cents, 0);
      const expNative = await loadExpectedNativeCents(knex, orderId);
      const residue = nativeEff - expNative;

      if (residue <= TOLERANCE_CENTS) {
        console.log(
          `${tag} SKIP already-aligned (native ${nativeEff}¢ ≈ expected ${expNative}¢)`
        );
        skipCount++;
        continue;
      }

      const refundable = payments
        .filter((p) => p.provider_id === SYSTEM_PROVIDER && p.available_cents > 0)
        .sort((a, b) => b.newest_capture_at - a.newest_capture_at); // newest first

      const nonSystem = payments.filter(
        (p) => p.provider_id !== SYSTEM_PROVIDER && p.available_cents > 0
      );
      if (nonSystem.length > 0) {
        console.log(
          `${tag} WARN skipping ${nonSystem.length} non-system payment(s) (${nonSystem
            .map((p) => p.provider_id)
            .join(",")}) — will NOT refund those`
        );
      }

      const refundableTotal = refundable.reduce(
        (s, p) => s + p.available_cents,
        0
      );
      const plannedCents = Math.min(residue, refundableTotal);

      console.log(
        `${tag} native=${nativeEff}¢ expected=${expNative}¢ residue=${residue}¢ ` +
          `→ refund ${plannedCents}¢ across ${refundable.length} system payment(s)` +
          (plannedCents < residue ? ` (capped by refundable ${refundableTotal}¢)` : "")
      );

      if (!APPLY) {
        totalRefundedCents += plannedCents;
        okCount++;
        continue;
      }

      // 3. Refund newest-first, chunked, never over-refunding a payment.
      let remaining = residue;
      for (const p of refundable) {
        if (remaining <= TOLERANCE_CENTS) break;
        const chunkCents = Math.min(remaining, p.available_cents);
        if (chunkCents <= 0) continue;
        await paymentModule.refundPayment({
          payment_id: p.id,
          amount: chunkCents / 100, // module expects DOLLARS
          created_by: "reconcile-void-residue",
          note: `Ledger reconciliation (Phase A) — void residue for order ${displayId}`,
        });
        remaining -= chunkCents;
        totalRefundedCents += chunkCents;
        console.log(`   ↳ refunded ${chunkCents}¢ from ${p.id}`);
      }

      // 4. Assert alignment after refund.
      const after = await loadNativePayments(query, orderId);
      const nativeAfter = after.reduce((s, p) => s + p.available_cents, 0);
      const residueAfter = nativeAfter - expNative;
      if (Math.abs(residueAfter) <= TOLERANCE_CENTS) {
        console.log(`${tag} ✅ aligned (native ${nativeAfter}¢ == expected ${expNative}¢)`);
        okCount++;
      } else {
        console.log(
          `${tag} ⚠️ residual ${residueAfter}¢ after refund (native ${nativeAfter}¢ vs expected ${expNative}¢)`
        );
        failures.push(`${tag}: residual ${residueAfter}¢`);
      }
    } catch (err: any) {
      console.log(`${tag} ❌ ERROR: ${err.message}`);
      failures.push(`${tag}: ${err.message}`);
    } finally {
      await knex.raw(`SELECT pg_advisory_unlock(hashtext(?))`, [orderId]);
    }
  }

  console.log(
    `\n[reconcile-void-residue] done — mode=${APPLY ? "APPLY" : "DRY_RUN"} | ` +
      `orders=${okCount} skipped=${skipCount} refunded=${totalRefundedCents}¢ ($${(
        totalRefundedCents / 100
      ).toFixed(2)}) | failures=${failures.length}`
  );
  if (failures.length) console.log("  failures:\n   - " + failures.join("\n   - "));
}

async function loadNativePayments(
  query: any,
  orderId: string
): Promise<PaymentRow[]> {
  const {
    data: [order],
  } = await query.graph({
    entity: "order",
    fields: [
      "payment_collections.payments.id",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captures.amount",
      "payment_collections.payments.captures.created_at",
      "payment_collections.payments.refunds.amount",
    ],
    filters: { id: orderId },
  });
  const rows: PaymentRow[] = [];
  for (const pc of order?.payment_collections ?? []) {
    for (const p of pc?.payments ?? []) {
      const capturedCents = (p.captures ?? []).reduce(
        (s: number, c: any) => s + toCents(c.amount),
        0
      );
      const refundedCents = (p.refunds ?? []).reduce(
        (s: number, r: any) => s + toCents(r.amount),
        0
      );
      const newest = (p.captures ?? []).reduce((mx: number, c: any) => {
        const t = c.created_at ? new Date(c.created_at).getTime() : 0;
        return t > mx ? t : mx;
      }, 0);
      rows.push({
        id: p.id,
        provider_id: p.provider_id ?? null,
        captured_cents: capturedCents,
        refunded_cents: refundedCents,
        available_cents: capturedCents - refundedCents,
        newest_capture_at: newest,
      });
    }
  }
  return rows;
}

async function loadExpectedNativeCents(
  knex: any,
  orderId: string
): Promise<number> {
  const { rows } = await knex.raw(
    `
    SELECT COALESCE(SUM(pa.amount_applied),0)::bigint AS exp_native
    FROM payment_application pa
    JOIN customer_payment cp ON cp.id = pa.payment_id AND cp.deleted_at IS NULL
    WHERE pa.order_id = ?
      AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
    `,
    [orderId]
  );
  return Number(rows[0]?.exp_native ?? 0);
}
