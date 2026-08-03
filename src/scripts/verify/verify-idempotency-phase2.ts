/**
 * verify-idempotency-phase2.ts — sandbox validation of gapless invoice
 * numbering + create-dedup (docs/IDEMPOTENCY_PLAN.md Phase 2).
 *
 * Run against SANDBOX only:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   REDIS_URL=redis://localhost:6399 \
 *   npx medusa exec ./src/scripts/verify/verify-idempotency-phase2.ts
 */
import { INVOICE_MODULE } from "../../modules/invoices";
import {
  allocateNextNumber,
  buildInvoiceRequestHash,
  claimInvoiceCreate,
  finalizeInvoiceCreate,
  type TxManager,
} from "../../lib/invoices/document-numbering";

type Pg = { raw: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

export default async function verifyIdempotencyPhase2({ container }: any) {
  const invoiceService: any = container.resolve(INVOICE_MODULE);
  const pg = container.resolve("__pg_connection__") as Pg;

  const readCounter = async (name: string): Promise<number> => {
    const r = await pg.raw(`SELECT value FROM document_number_counter WHERE name = ?`, [name]);
    return Number(r.rows[0].value);
  };

  // ── T1: gapless — allocate inside a tx that THROWS → counter unchanged ────
  const c0 = await readCounter("medusa_invoice");
  let allocatedInRolledBack = -1;
  try {
    await invoiceService.withTransaction(async (ctx: any) => {
      const em = ctx.transactionManager as unknown as TxManager;
      allocatedInRolledBack = await allocateNextNumber(em, "medusa_invoice");
      throw new Error("forced rollback");
    });
  } catch {
    /* expected */
  }
  const c1 = await readCounter("medusa_invoice");
  check(
    "T1 gapless: rollback does NOT advance counter",
    c1 === c0 && allocatedInRolledBack === c0 + 1,
    `before=${c0} allocated=${allocatedInRolledBack} after=${c1}`
  );

  // ── T2: commit advances counter by exactly 1 ─────────────────────────────
  let committedNum = -1;
  await invoiceService.withTransaction(async (ctx: any) => {
    const em = ctx.transactionManager as unknown as TxManager;
    committedNum = await allocateNextNumber(em, "medusa_invoice");
  });
  const c2 = await readCounter("medusa_invoice");
  check(
    "T2 commit: counter advances by 1",
    c2 === c1 + 1 && committedNum === c1 + 1,
    `before=${c1} allocated=${committedNum} after=${c2}`
  );

  // ── T3: ATOMIC ENLISTMENT — createPosInvoices + counter roll back together ─
  // Proves the MikroORM create enlists in the SAME physical tx as our raw em
  // writes: inside the tx the em SELECT must SEE the just-created row; after a
  // rollback NO row persists and the counter is unchanged.
  const c3before = await readCounter("medusa_invoice");
  const probeNum = `IDEMPTEST-${Date.now()}`;
  let emSawRowInTx = false;
  try {
    await invoiceService.withTransaction(async (ctx: any) => {
      const em = ctx.transactionManager as unknown as TxManager;
      await allocateNextNumber(em, "medusa_invoice");
      const created = await invoiceService.createPosInvoices(
        {
          invoice_number: probeNum,
          order_id: "idemp-test",
          customer_id: "idemp-test",
          subtotal: 0,
          tax: 0,
          untaxed_total: 0,
          total: 0,
          amount_paid: 0,
          balance_due: 0,
        },
        ctx
      );
      // MikroORM defers the INSERT until commit/flush, so flush first to make
      // the buffered row visible to a raw SELECT on the SAME connection.
      await (ctx.transactionManager as any).flush?.();
      const seen = await em.execute<any[]>(
        `SELECT id FROM pos_invoice WHERE id = ?`,
        [created.id]
      );
      emSawRowInTx = seen.length === 1;
      throw new Error("forced rollback after insert");
    });
  } catch {
    /* expected */
  }
  const persisted = await pg.raw(`SELECT id FROM pos_invoice WHERE invoice_number = ?`, [probeNum]);
  const c3after = await readCounter("medusa_invoice");
  check("T3a enlistment: em SEES MikroORM row inside same tx", emSawRowInTx);
  check(
    "T3b atomic: rolled-back insert leaves NO row + counter unchanged",
    persisted.rows.length === 0 && c3after === c3before,
    `rows=${persisted.rows.length} counter ${c3before}→${c3after}`
  );

  // ── T4: dedup claim / finalize / replay / conflict ───────────────────────
  const key = `header:idemp-${Date.now()}`;
  const hashA = "hashAAA";
  const hashB = "hashBBB";

  // First claim → claimed
  let firstClaim: any;
  await invoiceService.withTransaction(async (ctx: any) => {
    firstClaim = await claimInvoiceCreate(ctx.transactionManager as unknown as TxManager, key, hashA);
  });
  check("T4a first claim → claimed", firstClaim?.status === "claimed", JSON.stringify(firstClaim));

  // Finalize with a fake invoice id (separate tx)
  await invoiceService.withTransaction(async (ctx: any) => {
    await finalizeInvoiceCreate(ctx.transactionManager as unknown as TxManager, key, hashA, "inv_fake_123");
  });

  // Replay same key+hash → existing(inv_fake_123)
  let replay: any;
  await invoiceService.withTransaction(async (ctx: any) => {
    replay = await claimInvoiceCreate(ctx.transactionManager as unknown as TxManager, key, hashA);
  });
  check(
    "T4b replay same key+hash → existing(invoice)",
    replay?.status === "existing" && replay?.invoiceId === "inv_fake_123",
    JSON.stringify(replay)
  );

  // Same key, DIFFERENT hash → conflict
  let conflict: any;
  await invoiceService.withTransaction(async (ctx: any) => {
    conflict = await claimInvoiceCreate(ctx.transactionManager as unknown as TxManager, key, hashB);
  });
  check("T4c same key, different payload → conflict", conflict?.status === "conflict", JSON.stringify(conflict));

  // Orphan claim (claimed but never finalized) → in_progress on replay
  const orphanKey = `header:orphan-${Date.now()}`;
  await invoiceService.withTransaction(async (ctx: any) => {
    await claimInvoiceCreate(ctx.transactionManager as unknown as TxManager, orphanKey, hashA);
  });
  let orphanReplay: any;
  await invoiceService.withTransaction(async (ctx: any) => {
    orphanReplay = await claimInvoiceCreate(ctx.transactionManager as unknown as TxManager, orphanKey, hashA);
  });
  check(
    "T4d committed claim w/o invoice_id → in_progress",
    orphanReplay?.status === "in_progress",
    JSON.stringify(orphanReplay)
  );

  // ── T6: COMMIT happy-path — full create persists atomically ──────────────
  // Mirrors the route's tx body: claim → allocate → createPosInvoices →
  // finalize, committed. Proves the positive path persists the row with the
  // allocated number, advances the counter by 1, and stamps the claim.
  const t6before = await readCounter("medusa_invoice");
  const t6key = `header:commit-${Date.now()}`;
  let t6num = "";
  let t6id = "";
  await invoiceService.withTransaction(async (ctx: any) => {
    const em = ctx.transactionManager as unknown as TxManager;
    const claim = await claimInvoiceCreate(em, t6key, "hashCommit");
    if (claim.status !== "claimed") throw new Error("expected claimed");
    t6num = String(await allocateNextNumber(em, "medusa_invoice"));
    const created = await invoiceService.createPosInvoices(
      {
        invoice_number: t6num,
        order_id: "idemp-commit",
        customer_id: "idemp-commit",
        subtotal: 0,
        tax: 0,
        untaxed_total: 0,
        total: 0,
        amount_paid: 0,
        balance_due: 0,
      },
      ctx
    );
    t6id = created.id;
    await finalizeInvoiceCreate(em, t6key, "hashCommit", created.id);
  });
  const t6after = await readCounter("medusa_invoice");
  const t6row = await pg.raw(`SELECT invoice_number FROM pos_invoice WHERE id = ?`, [t6id]);
  const t6attempt = await pg.raw(`SELECT invoice_id FROM invoice_create_attempt WHERE dedup_key = ?`, [t6key]);
  check(
    "T6 commit happy-path: row persisted with allocated number + counter+1 + claim stamped",
    t6after === t6before + 1 &&
      t6num === String(t6before + 1) &&
      t6row.rows[0]?.invoice_number === t6num &&
      t6attempt.rows[0]?.invoice_id === t6id,
    `counter ${t6before}→${t6after} num=${t6num} row=${t6row.rows[0]?.invoice_number} stamp=${t6attempt.rows[0]?.invoice_id === t6id}`
  );
  // Cleanup the committed probe rows.
  await pg.raw(`DELETE FROM pos_invoice WHERE id = ?`, [t6id]);
  await pg.raw(`DELETE FROM invoice_create_attempt WHERE dedup_key = ?`, [t6key]);

  // ── T5: finalize fail-closed — wrong key throws ──────────────────────────
  let threw = false;
  try {
    await invoiceService.withTransaction(async (ctx: any) => {
      await finalizeInvoiceCreate(ctx.transactionManager as unknown as TxManager, "header:does-not-exist", hashA, "x");
    });
  } catch {
    threw = true;
  }
  check("T5 finalize fail-closed: missing claim throws", threw);

  // ── T7: warranty confirmation participates in the request fingerprint ───
  const warrantyFingerprintInput = {
    order_id: "idemp-zero-warranty",
    customer_id: "idemp-customer",
    subtotal: 0,
    discount: 0,
    shipping: 0,
    tax: 0,
    total: 0,
    amount_paid: 0,
    payment_method: null,
    card_brand: null,
    items: [
      {
        sku: "WARRANTY-PROBE",
        variant_id: "variant-probe",
        quantity: 1,
        unit_price: 0,
        total: 0,
        net_total: 0,
      },
    ],
  } as const;
  const withoutWarranty = buildInvoiceRequestHash({
    ...warrantyFingerprintInput,
    zero_total_reason: null,
  });
  const withWarranty = buildInvoiceRequestHash({
    ...warrantyFingerprintInput,
    zero_total_reason: "warranty",
  });
  const warrantyReplay = buildInvoiceRequestHash({
    ...warrantyFingerprintInput,
    zero_total_reason: "warranty",
  });
  check(
    "T7 warranty evidence changes the hash and remains replay-stable",
    withoutWarranty !== withWarranty && withWarranty === warrantyReplay
  );

  // Cleanup test dedup rows (leave counters as-is — gaps from T2/T5 are expected).
  await pg.raw(`DELETE FROM invoice_create_attempt WHERE dedup_key LIKE 'header:idemp-%' OR dedup_key LIKE 'header:orphan-%'`);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) throw new Error(`${fail} idempotency checks FAILED`);
}
