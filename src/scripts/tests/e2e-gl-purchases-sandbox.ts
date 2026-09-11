/**
 * e2e-gl-purchases-sandbox.ts — E2E del motor de compras del GL contra el
 * SANDBOX `medusa_gl` (gl-purchases-v2 §6).
 *
 * Direct-DB únicamente: arma un PO + línea + receipt + vendor bill mínimos
 * por INSERT crudo (reusando un `vendor_id`/`stock_location_id`/
 * `product_variant_id` REALES del sandbox — `e2e-gl-purchases-fixtures.ts`),
 * y llama a las funciones de documento del motor (`src/lib/ledger`) directo —
 * NUNCA pasa por las rutas HTTP reales (esas encolan QB vía `src/lib/quickbooks/**`,
 * fuera del scope de este plan; el bridge está OFF en sandbox de cualquier
 * forma).
 *
 * Phase 7 (2026-09-11): las patas de vendor-credit y bill-payment YA NO
 * saltean el ciclo de vida real (antes: `INSERT status='posted'` a mano +
 * llamada directa al motor). Eso es exactamente lo que dejó pasar un bug real
 * en `lib/vendor-credits/void.ts`/`lib/bill-payments/void.ts`
 * (`BANKING_INVALID_ACCOUNTING_DATE` — `credit_date`/`payment_date` vuelven
 * de `pg` como objeto `Date`, no string; F2 ya lo arregló con `pgDateToIso`).
 * Ahora se llama a `createDraftVendorCredit` → `updateDraftVendorCredit` →
 * `markVendorCreditPosted` → `applyVendorCreditToBill` →
 * `voidVendorCreditApplication` → `voidVendorCredit`, y a `createBillPayment`
 * → `voidBillPayment` — el motor del GL (`postVendorCredit`/`postBillPayment`/
 * sus reversas) se sigue llamando a mano después de cada paso, porque ESE
 * hook vive en las RUTAS reales (`src/api/admin/vendor-credits/**`,
 * `bill-payments/**`), no en la librería — igual que hace cada route real.
 *
 * Todo el fixture vive bajo `id`s con prefijo `e2egl_` y se limpia al final
 * (domain rows), tanto si los asserts pasan como si no — el journal es
 * append-only, así que antes de borrar se reversa TODO lo que sigue activo.
 *
 * Aborta si `DATABASE_URL` no contiene `/medusa_gl` — nunca `medusa`, nunca prod.
 *
 * Flujo: receipt → vendor bill regular (con variación de precio) → post de
 * ambos → simular reconfirm → drift reversa+repostea → vendor credit
 * (draft→post→aplicar al bill→des-aplicar→void) → bill payment (crear→void)
 * → cancelar el bill → reversa espejo.
 *
 * Correr:
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_gl' \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-gl-purchases-sandbox.ts
 */
import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import {
  activeDocumentEntry,
  postBillPayment,
  postReceipt,
  postVendorBill,
  postVendorCredit,
  reconcilePurchaseDrift,
  reverseBillPayment,
  reverseReceipt,
  reverseVendorBill,
  reverseVendorCredit,
} from "../../lib/ledger";
import { createBillPayment, voidBillPayment } from "../../lib/bill-payments";
import {
  applyVendorCreditToBill,
  createDraftVendorCredit,
  markVendorCreditPosted,
  updateDraftVendorCredit,
  voidVendorCredit,
  voidVendorCreditApplication,
} from "../../lib/vendor-credits";

import { buildFixture, cleanup, type Fixture } from "./e2e-gl-purchases-fixtures";

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const ok = (name: string, cond: boolean, detail?: string) => checks.push({ name, ok: cond, detail });

const FX = `e2egl_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const today = new Date().toISOString().slice(0, 10);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !url.includes("/medusa_gl")) {
    console.error(`e2e-gl-purchases-sandbox: DATABASE_URL debe apuntar a /medusa_gl. Valor actual: ${url ?? "(vacío)"}`);
    process.exit(1);
    return;
  }

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  let fx: Fixture | null = null;
  let creditId: string | null = null;
  let paymentId: string | null = null;
  try {
    // Cada paso de acá en más COMMITEA de verdad — a propósito, NO en una
    // única transacción envolvente: `bank_journal_entry.created_at` es
    // `DEFAULT NOW()`, y `NOW()` es CONSTANTE durante toda una transacción en
    // Postgres. Con commits reales el reloj avanza como en producción.
    await client.query("BEGIN");
    fx = await buildFixture(client, FX);
    await client.query("COMMIT");

    const r1 = await postReceipt(client, fx.receiptId, "e2e");
    ok("receipt postea", r1.status === "posted", JSON.stringify(r1));
    const receiptEntry = await activeDocumentEntry(client, "po_receipt", fx.receiptId);
    ok("receipt: offset = 10 × $10.00 = $100.00", receiptEntry?.amount_cents === "10000", `amount=${receiptEntry?.amount_cents}`);

    const r2 = await postVendorBill(client, fx.billId, "e2e");
    ok("bill postea", r2.status === "posted", JSON.stringify(r2));
    const billLines = await activeLinesFor(client, "vendor_bill", fx.billId);
    ok("bill: clears the $100.00 offset", billLines.find((l) => l.role === "inventory_offset")?.debit_cents === "10000");
    ok(
      "bill: $20.00 price variance capitalizes to inventory_asset",
      billLines.find((l) => l.role === "inventory_asset")?.debit_cents === "2000"
    );
    ok("bill: AP = $120.00 (payable)", billLines.find((l) => l.role === "accounts_payable")?.credit_cents === "12000");

    // ── Reconfirm simulado: cambia landed_total_cents sin repostear ──
    await client.query(`UPDATE vendor_bill_line SET landed_total_cents = 9999 WHERE id = $1`, [fx.vblId]);
    // `reconcilePurchaseDrift` usa SAVEPOINT por bill — sólo válido DENTRO de
    // una transacción ya abierta (`ledger-reconciler.ts` la abre explícito).
    await client.query("BEGIN");
    const drift = await reconcilePurchaseDrift(client);
    await client.query("COMMIT");
    ok("drift: detecta el cambio y reversa+repostea", drift.reversed >= 1 && drift.reposted >= 1, JSON.stringify(drift));
    const repostedLines = await activeLinesFor(client, "vendor_bill", fx.billId);
    ok(
      "drift: el repost sigue balanceado con el mismo AP",
      repostedLines.find((l) => l.role === "accounts_payable")?.credit_cents === "12000"
    );

    // ── Vendor credit: ciclo de vida REAL (F2), $50.00, producto ──
    // Plan vc-po-return-20260911: un crédito con líneas de producto nombra su
    // PO y cada línea la línea del PO que devuelve (tope = recibido). El
    // fixture recibió 10 en `polId`, así que 1 → 5 unidades caben.
    const draft = await createDraftVendorCredit(client, {
      vendor_id: fx.vendor_id,
      credit_date: today,
      purchase_order_id: fx.poId,
      lines: [{ line_type: "product", purchase_order_line_id: fx.polId, qty: 1, unit_cost_cents: 100, amount_cents: 100 }],
      actor_id: "e2e",
    });
    creditId = draft.id;
    await updateDraftVendorCredit(client, creditId, {
      lines: [{ line_type: "product", purchase_order_line_id: fx.polId, variant_id: fx.product_variant_id, sku: "E2E-SKU", qty: 5, unit_cost_cents: 1000, amount_cents: 5000 }],
    });
    const posted = await markVendorCreditPosted(client, creditId, "e2e");
    ok("vendor credit: draft→posted (ciclo real)", posted.id === creditId, JSON.stringify(posted));
    const r3 = await postVendorCredit(client, creditId, "e2e");
    ok("vendor credit postea al GL", r3.status === "posted", JSON.stringify(r3));
    const creditLines = await activeLinesFor(client, "vendor_credit", creditId);
    ok(
      "vendor credit: AP debitada $50.00, inventory_asset creditado $50.00",
      creditLines.some((l) => l.role === "accounts_payable" && l.debit_cents === "5000") &&
        creditLines.some((l) => l.role === "inventory_asset" && l.credit_cents === "5000"),
      JSON.stringify(creditLines)
    );

    const application = await applyVendorCreditToBill(client, {
      creditId,
      vendorBillId: fx.billId,
      amountCents: 5000,
      actorId: "e2e",
    });
    ok("vendor credit: aplicado al bill (§2 — sin asiento propio)", !!application.id, JSON.stringify(application));
    await voidVendorCreditApplication(client, application.id, "e2e");
    ok("vendor credit: aplicación des-aplicada (voidVendorCreditApplication)", true);
    await voidVendorCredit(client, creditId, "e2e", "e2e teardown");
    await reverseVendorCredit(client, creditId, "e2e", "e2e teardown");
    const creditStillActive = await activeDocumentEntry(client, "vendor_credit", creditId);
    ok("vendor credit: sin entrada activa tras voidVendorCredit + reverseVendorCredit", creditStillActive === null);

    // ── Bill payment: ciclo de vida REAL (F2), $70.00, Bank ──
    if (fx.bank_list_id) {
      const payment = await createBillPayment(client, {
        vendor_id: fx.vendor_id,
        bank_account_list_id: fx.bank_list_id,
        payment_date: today,
        method: "check",
        allocations: [{ vendor_bill_id: fx.billId, amount_cents: 7000 }],
        actor_id: "e2e",
      });
      paymentId = payment.id;
      ok("bill payment: creado (ciclo real)", !!paymentId, JSON.stringify(payment));
      const r4 = await postBillPayment(client, paymentId, "e2e");
      ok("bill payment postea al GL", r4.status === "posted", JSON.stringify(r4));
      const payLines = await activeLinesFor(client, "vendor_bill_payment", paymentId);
      ok(
        "bill payment: AP debitada $70.00, banco creditado $70.00",
        payLines.some((l) => l.role === "accounts_payable" && l.debit_cents === "7000") &&
          payLines.some((l) => l.role === "bank_account" && l.credit_cents === "7000"),
        JSON.stringify(payLines)
      );
      await voidBillPayment(client, paymentId, "e2e", "e2e teardown");
      await reverseBillPayment(client, paymentId, "e2e", "e2e teardown");
      const paymentStillActive = await activeDocumentEntry(client, "vendor_bill_payment", paymentId);
      ok("bill payment: sin entrada activa tras voidBillPayment + reverseBillPayment", paymentStillActive === null);
    } else {
      ok("bill payment (SKIPPED: sin cuenta Bank activa en el sandbox)", true);
    }

    // ── Cancel: reversa espejo del bill ──
    const rev = await reverseVendorBill(client, fx.billId, "e2e", "e2e cancel test");
    ok("cancel: reversa el bill", rev.status === "reversed", JSON.stringify(rev));
    const stillActive = await activeDocumentEntry(client, "vendor_bill", fx.billId);
    ok("cancel: ninguna entrada activa después de reversar", stillActive === null);

    await reverseReceipt(client, fx.receiptId, "e2e", "e2e fixture teardown");

    // Trial balance del fixture completo: Σdebit = Σcredit sobre TODO lo tocado hoy.
    const { rows: tb } = await client.query<{ d: string; c: string }>(
      `SELECT COALESCE(SUM(debit_cents),0)::text AS d, COALESCE(SUM(credit_cents),0)::text AS c
         FROM bank_journal_line l JOIN bank_journal_entry e ON e.id = l.entry_id
        WHERE e.source_id = ANY($1)`,
      [[fx.billId, fx.receiptId, creditId, paymentId].filter((x): x is string => !!x)]
    );
    ok("trial balance del fixture: Σdebit = Σcredit", tb[0]?.d === tb[0]?.c, JSON.stringify(tb[0]));
  } finally {
    if (fx) await cleanup(client, fx, creditId, paymentId).catch((e) => console.error("cleanup failed:", e));
    client.release();
    await pool.end();
  }

  console.log(`\n${"═".repeat(64)}\ne2e-gl-purchases-sandbox: ${checks.filter((c) => c.ok).length}/${checks.length} OK`);
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  if (checks.some((c) => !c.ok)) process.exit(1);
}

/**
 * Líneas de la entrada `document` ACTIVA (sin reversa) de un source — con
 * `e.kind = 'document'` explícito: sin él, una reversa recién creada (a la
 * que nada la reversa todavía) también matchea el `NOT EXISTS` y compite por
 * la fila sin `ORDER BY` (medido: flakeó real en esta misma suite).
 */
async function activeLinesFor(
  client: PoolClient,
  sourceKind: string,
  sourceId: string
): Promise<Array<{ role: string; debit_cents: string; credit_cents: string }>> {
  const { rows } = await client.query<{ role: string; debit_cents: string; credit_cents: string }>(
    `SELECT l.role, l.debit_cents::text, l.credit_cents::text
       FROM bank_journal_line l JOIN bank_journal_entry e ON e.id = l.entry_id
      WHERE e.kind = 'document' AND e.source_kind = $1 AND e.source_id = $2
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)`,
    [sourceKind, sourceId]
  );
  return rows;
}

void main();
