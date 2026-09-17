/**
 * e2e-sales-tax-sandbox — Sales Tax Center de punta a punta contra el SANDBOX
 * (plan sales-tax-center-20260917). Ejercita por HTTP lo que la pantalla hace y
 * verifica el EFECTO en la base: períodos (exentos corregidos, vencimientos FL),
 * Prepare/File/Reopen, ajuste STA (PIN, asiento, JournalEntryAdd con EntityRef),
 * pago STP (PIN, asiento neto, un pago por período, SalesTaxPaymentCheckAdd de
 * dos líneas cuando el STA ya tiene TxnID), voids (reversa + pipeline) y los
 * negativos (facturas y cheques intactos, el payable vuelve a su saldo).
 *
 *   SANDBOX_BASE_URL=http://localhost:9097 \
 *   SANDBOX_DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa_stx \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-sales-tax-sandbox.ts
 *
 * Requiere: migración SalesTaxCenter aplicada, Settings listos (tax item + vendor +
 * banco default), un admin con Accounting y `pos_supervisor_pin` en el store.
 */
import { Client } from "pg";
import { WRITE } from "../../lib/quickbooks/pipeline-status";

import { loadGlDocumentAddFacts } from "../../lib/quickbooks/gl-documents/facts";

const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB = process.env.SANDBOX_DATABASE_URL ?? "postgresql://postgres:sandbox@localhost:5499/medusa";
const PERIOD = process.env.E2E_PERIOD ?? "2026-08";

function abort(why: string): never {
  console.error(`\n❌ ABORTADO: ${why}\n`);
  process.exit(2);
}
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+(\/|$)/.test(BASE)) abort(`BASE apunta a ${BASE}: este script SOLO corre contra un backend sandbox local`);
if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) abort("la DB no es la del sandbox (se esperaba localhost:5499)");

interface Result { ok: boolean; name: string; detail: string }
const results: Result[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function call(path: string, opts: { method?: string; token: string; body?: unknown; pin?: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` };
  if (opts.pin) headers["x-supervisor-pin"] = opts.pin;
  const res = await fetch(`${BASE}${path}`, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const db = new Client({ connectionString: SB_DB });
  await db.connect();
  const pin = (await db.query<{ pin: string }>(`SELECT metadata->>'pos_supervisor_pin' AS pin FROM store WHERE metadata->>'pos_supervisor_pin' IS NOT NULL LIMIT 1`)).rows[0]?.pin;
  if (!pin) abort("el store del sandbox no tiene pos_supervisor_pin");
  const auth = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com", password: process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123" }),
  });
  const token = ((await auth.json().catch(() => ({}))) as { token?: string }).token;
  if (!token) abort(`login falló (HTTP ${auth.status})`);

  const payableBalance = async () =>
    BigInt((await db.query<{ b: string }>(`SELECT COALESCE(SUM(l.credit_cents - l.debit_cents),0)::text AS b FROM bank_journal_line l JOIN bank_journal_entry e ON e.id = l.entry_id JOIN gl_account_map m ON m.key='sales_tax_payable' AND m.qb_list_id = l.account_list_id WHERE l.deleted_at IS NULL AND e.deleted_at IS NULL`)).rows[0]!.b);
  const count = async (sql: string) => (await db.query<{ n: string }>(sql)).rows[0]!.n;
  const invoicesBefore = await count(`SELECT COUNT(*)::text AS n FROM pos_invoice WHERE deleted_at IS NULL`);
  const checksBefore = await count(`SELECT COUNT(*)::text AS n FROM gl_check WHERE deleted_at IS NULL`);
  const balanceBefore = await payableBalance();

  // Pre-limpieza: otra corrida (o el E2E del POS, que registra el pago con
  // file_return) puede haber dejado la declaración del período preparada/filed.
  await call(`/admin/accounting/sales-tax/periods/${PERIOD}/reopen`, { method: "POST", token, body: {}, pin });

  // ── 1 · settings + períodos ────────────────────────────────────────────────
  console.log("\n§1 settings y períodos");
  const settings = await call("/admin/accounting/sales-tax/settings", { token });
  check("GET settings 200 y listos", settings.status === 200 && (settings.body.settings as { ready: boolean }).ready === true, JSON.stringify((settings.body.settings as { missing?: string[] })?.missing));
  const periods = await call(`/admin/accounting/sales-tax/periods?from=2025-12&to=${PERIOD}`, { token });
  const list = (periods.body.periods ?? []) as Array<Record<string, unknown>>;
  check("GET periods 200 con filas", periods.status === 200 && list.length >= 2, `${list.length} períodos`);
  const detail = await call(`/admin/accounting/sales-tax/periods/${PERIOD}`, { token });
  const live = detail.body.live as { sales: Record<string, string>; due: Record<string, string>; return_status: string; payment_status: string; allowance_suggested_cents: string; adjustments: unknown[] };
  check(`GET period ${PERIOD} 200`, detail.status === 200 && !!live);
  check("exentos de cliente (tax=0 con ítems gravables) contados en la línea B", BigInt(live.sales.exempt_customer_cents) > 0n, `$${(Number(live.sales.exempt_customer_cents) / 100).toFixed(2)}`);
  check("gross = taxable + exempt", BigInt(live.sales.gross_cents) === BigInt(live.sales.taxable_cents) + BigInt(live.sales.exempt_cents));
  if (PERIOD === "2026-08") check("vencimientos FL: filing 09/21 (el 20 es domingo), e-pago 09/18", live.due.filing_due === "2026-09-21" && live.due.epay_cutoff === "2026-09-18", JSON.stringify(live.due));
  check("período abierto y sin pago", live.return_status === "open" && live.payment_status === "unpaid");
  check("allowance sugerido = $30 (tax > $1,200)", live.allowance_suggested_cents === "3000", live.allowance_suggested_cents);
  const taxCents = BigInt(live.sales.tax_collected_cents);
  check("tax cobrado del período > 0", taxCents > 0n, `$${(Number(taxCents) / 100).toFixed(2)}`);

  // ── 2 · prepare / file ─────────────────────────────────────────────────────
  console.log("\n§2 declaración");
  const prep = await call(`/admin/accounting/sales-tax/periods/${PERIOD}/prepare`, { method: "POST", token, body: { notes: "e2e" } });
  check("Prepare → 201 ready", prep.status === 201 && (prep.body.return as { status: string })?.status === "ready");
  const prep2 = await call(`/admin/accounting/sales-tax/periods/${PERIOD}/prepare`, { method: "POST", token, body: {} });
  check("segundo Prepare → 409", prep2.status === 409, String(prep2.status));

  // ── 3 · ajuste STA ─────────────────────────────────────────────────────────
  console.log("\n§3 ajuste (Adjust Sales Tax Due)");
  const adjBody = { period: PERIOD, day: "2026-09-17", type: "collection_allowance", amount_cents: 3000, reason: "e2e allowance" };
  const noPin = await call("/admin/accounting/sales-tax/adjustments", { method: "POST", token, body: adjBody });
  check("POST adjustment sin PIN → 403", noPin.status === 403, String(noPin.status));
  const adj = await call("/admin/accounting/sales-tax/adjustments", { method: "POST", token, body: adjBody, pin });
  const adjustment = adj.body.adjustment as { id: string; doc_number: string; status: string; direction: string; entry_id: string } | undefined;
  check("POST adjustment con PIN → 201 posted", adj.status === 201 && adjustment?.status === "posted" && adjustment.direction === "decrease", JSON.stringify(adj.body).slice(0, 200));
  if (!adjustment) abort("sin ajuste no se puede seguir");
  const adjLines = (await db.query<{ role: string; debit_cents: string; credit_cents: string }>(`SELECT role, debit_cents::text, credit_cents::text FROM bank_journal_line WHERE entry_id = $1 AND deleted_at IS NULL ORDER BY role`, [adjustment.entry_id])).rows;
  check("asiento del ajuste: Dr payable 30 / Cr contrapartida 30", adjLines.length === 2 && adjLines.some((l) => l.role === "sales_tax_payable" && l.debit_cents === "3000") && adjLines.some((l) => l.role === "offset" && l.credit_cents === "3000"), JSON.stringify(adjLines));
  const adjRow = (await db.query<{ status: string; payload: { qbxml: string | null; ready: boolean; qb_txn_type: string } }>(`SELECT status, payload FROM qb_order_pipeline WHERE step='gl_document_add' AND reference_type='gl_sales_tax_adjustment' AND reference_id=$1 ORDER BY created_at DESC LIMIT 1`, [adjustment.id])).rows[0];
  check("pipeline: fila gl_document_add del STA, ready, JournalEntryAdd con EntityRef del vendor", !!adjRow && adjRow.payload.ready === true && /JournalEntryAddRq/.test(adjRow.payload.qbxml ?? "") && /<EntityRef><ListID>80000042-1338583015<\/ListID><\/EntityRef>/.test(adjRow.payload.qbxml ?? ""), adjRow ? `${adjRow.status} · ${adjRow.payload.qb_txn_type}` : "sin fila");

  // ── 4 · pago STP ───────────────────────────────────────────────────────────
  console.log("\n§4 pago (Pay Sales Tax)");
  const payBody = { period: PERIOD, day: "2026-09-18", tax_cents: taxCents.toString(), adjustment_ids: [adjustment.id], reference: "ACH-E2E", memo: "e2e", file_return: false };
  const payNoPin = await call("/admin/accounting/sales-tax/payments", { method: "POST", token, body: payBody });
  check("POST payment sin PIN → 403", payNoPin.status === 403, String(payNoPin.status));
  const pay = await call("/admin/accounting/sales-tax/payments", { method: "POST", token, body: payBody, pin });
  const payment = pay.body.payment as { id: string; doc_number: string; status: string; total_cents: string; tax_cents: string; adjustments_cents: string; entry_id: string; bank_account_list_id: string; lines: Array<{ kind: string; adjustment_id: string | null; amount_cents: string }> } | undefined;
  check("POST payment con PIN → 201 posted", pay.status === 201 && payment?.status === "posted", JSON.stringify(pay.body).slice(0, 200));
  if (!payment) abort("sin pago no se puede seguir");
  check("total = tax − allowance (derivado en el servidor)", BigInt(payment.total_cents) === taxCents - 3000n && payment.adjustments_cents === "-3000", `${payment.tax_cents} ${payment.adjustments_cents} ${payment.total_cents}`);
  check("líneas: tax + adjustment enlazado al STA", payment.lines.length === 2 && payment.lines[0]!.kind === "tax" && payment.lines[1]!.adjustment_id === adjustment.id && payment.lines[1]!.amount_cents === "-3000");
  const payLines = (await db.query<{ role: string; debit_cents: string; credit_cents: string; account_list_id: string }>(`SELECT role, debit_cents::text, credit_cents::text, account_list_id FROM bank_journal_line WHERE entry_id = $1 AND deleted_at IS NULL ORDER BY role`, [payment.entry_id])).rows;
  check("asiento del pago: Dr payable NETO / Cr banco NETO", payLines.length === 2 && payLines.some((l) => l.role === "sales_tax_payable" && l.debit_cents === payment.total_cents) && payLines.some((l) => l.role === "bank_account" && l.credit_cents === payment.total_cents && l.account_list_id === payment.bank_account_list_id), JSON.stringify(payLines));
  const applied = (await db.query<{ applied_payment_id: string | null }>(`SELECT applied_payment_id FROM gl_sales_tax_adjustment WHERE id = $1`, [adjustment.id])).rows[0]!;
  check("el STA quedó aplicado al STP", applied.applied_payment_id === payment.id);
  const payRow = (await db.query<{ status: string; payload: { ready: boolean; reason?: string; blocking_reference_ids?: string[] } }>(`SELECT status, payload FROM qb_order_pipeline WHERE step='gl_document_add' AND reference_type='gl_sales_tax_payment' AND reference_id=$1 ORDER BY created_at DESC LIMIT 1`, [payment.id])).rows[0];
  check("pipeline: STP transitorio, esperando el TxnID del STA (nunca un ADD antes del JE)", !!payRow && payRow.payload.ready === false && (payRow.payload.blocking_reference_ids ?? []).includes(adjustment.id) && !([WRITE.sales.failed, WRITE.sales.skipped] as string[]).includes(payRow.status), payRow ? `${payRow.status} · ${payRow.payload.reason}` : "sin fila");
  const dup = await call("/admin/accounting/sales-tax/payments", { method: "POST", token, body: payBody, pin });
  check("segundo pago del mismo período → 409", dup.status === 409, String(dup.status));
  const after = await call(`/admin/accounting/sales-tax/periods/${PERIOD}`, { token });
  const afterLive = after.body.live as { payment_status: string; paid_cents: string; remittance: Record<string, string> };
  check("período: pending_qb, pagado = total, remesa = tax − allowance", afterLive.payment_status === "pending_qb" && afterLive.paid_cents === payment.total_cents && afterLive.remittance.remittance_cents === payment.total_cents, JSON.stringify({ ps: afterLive.payment_status, paid: afterLive.paid_cents, rem: afterLive.remittance.remittance_cents }));

  // simular el JE confirmado en QuickBooks → el STP se vuelve READY con la forma de dos líneas
  await db.query(`UPDATE gl_sales_tax_adjustment SET qb_txn_id = 'E2E-ADJ-TXN', qb_txn_type = 'JournalEntry', qb_synced_at = now() WHERE id = $1`, [adjustment.id]);
  const facts = await loadGlDocumentAddFacts({ raw: async (sql, bindings) => { let i = 0; const text = sql.replace(/\?/g, () => `$${++i}`); return db.query(text, bindings as unknown[]); } }, "gl_sales_tax_payment", payment.id);
  const xml = facts.ready ? facts.qbxml : "";
  check("facts del STP tras el TxnID del STA: READY, SalesTaxPaymentCheckAdd de 2 líneas (item + −30.00), neto correcto", facts.ready && /SalesTaxPaymentCheckAddRq/.test(xml) && /<SalesTaxPaymentCheckLineAdd><ItemSalesTaxRef><ListID>8000010E-1340914624<\/ListID><\/ItemSalesTaxRef><Amount>[\d.]+<\/Amount><\/SalesTaxPaymentCheckLineAdd><SalesTaxPaymentCheckLineAdd><Amount>-30\.00<\/Amount>/.test(xml) && /<PayeeEntityRef><ListID>80000042-1338583015/.test(xml) && /<RefNumber>ACH-E2E<\/RefNumber>/.test(xml), facts.ready ? "" : facts.reason);
  await db.query(`UPDATE gl_sales_tax_adjustment SET qb_txn_id = NULL, qb_txn_type = NULL, qb_synced_at = NULL WHERE id = $1`, [adjustment.id]);

  // ── 5 · file / reopen ─────────────────────────────────────────────────────
  console.log("\n§5 filed / reopen");
  const filed = await call(`/admin/accounting/sales-tax/periods/${PERIOD}/file`, { method: "POST", token, body: { confirmation_number: "E2E-CONF-1", filed_amount_cents: payment.total_cents } });
  check("Mark filed → filed con confirmación", filed.status === 200 && (filed.body.return as { status: string; confirmation_number: string })?.confirmation_number === "E2E-CONF-1");
  const reopenNoPin = await call(`/admin/accounting/sales-tax/periods/${PERIOD}/reopen`, { method: "POST", token, body: {} });
  check("Reopen sin PIN → 403", reopenNoPin.status === 403, String(reopenNoPin.status));

  // ── 6 · voids ─────────────────────────────────────────────────────────────
  console.log("\n§6 anulaciones");
  const voidAdjApplied = await call(`/admin/accounting/sales-tax/adjustments/${adjustment.id}/void`, { method: "POST", token, body: { reason: "e2e" }, pin });
  check("void de un STA aplicado → 400 adjustment_applied", voidAdjApplied.status === 400 && /adjustment_applied/.test(JSON.stringify(voidAdjApplied.body)), String(voidAdjApplied.status));
  const voidNoPin = await call(`/admin/accounting/sales-tax/payments/${payment.id}/void`, { method: "POST", token, body: { reason: "e2e" } });
  check("void payment sin PIN → 403", voidNoPin.status === 403, String(voidNoPin.status));
  const voided = await call(`/admin/accounting/sales-tax/payments/${payment.id}/void`, { method: "POST", token, body: { reason: "e2e void" }, pin });
  check("void payment con PIN → voided", voided.status === 200 && (voided.body.payment as { status: string })?.status === "voided", JSON.stringify(voided.body).slice(0, 160)); // entity-status
  const reversal = await count(`SELECT COUNT(*)::text AS n FROM bank_journal_entry WHERE reverses_entry_id = '${payment.entry_id}' AND deleted_at IS NULL`);
  check("reversa del asiento del pago", reversal === "1");
  const released = (await db.query<{ applied_payment_id: string | null }>(`SELECT applied_payment_id FROM gl_sales_tax_adjustment WHERE id = $1`, [adjustment.id])).rows[0]!;
  check("el STA vuelve a estar disponible", released.applied_payment_id === null);
  const addRowAfterVoid = (await db.query<{ status: string }>(`SELECT status FROM qb_order_pipeline WHERE step='gl_document_add' AND reference_type='gl_sales_tax_payment' AND reference_id=$1 ORDER BY created_at DESC LIMIT 1`, [payment.id])).rows[0];
  check("pipeline: el ADD nunca enviado queda skipped (sin TxnVoid porque no hay TxnID)", addRowAfterVoid?.status === WRITE.sales.skipped, addRowAfterVoid?.status);
  const voidAdj = await call(`/admin/accounting/sales-tax/adjustments/${adjustment.id}/void`, { method: "POST", token, body: { reason: "e2e" }, pin });
  check("void del STA (ya liberado) → voided", voidAdj.status === 200 && (voidAdj.body.adjustment as { status: string })?.status === "voided"); // entity-status
  const reopen = await call(`/admin/accounting/sales-tax/periods/${PERIOD}/reopen`, { method: "POST", token, body: {}, pin });
  check("Reopen con PIN → removed", reopen.status === 200 && reopen.body.removed === true);

  // ── 6b · "ya presenté y pagué" en un paso: allowance inline + return filed ──
  console.log("\n§6b pago en un paso (allowance inline + filed)");
  const one = await call("/admin/accounting/sales-tax/payments", {
    method: "POST", token, pin,
    body: { period: PERIOD, day: "2026-09-18", tax_cents: taxCents.toString(), collection_allowance_cents: 3000, reference: "DOR-CONF-77", file_return: true },
  });
  const onePay = one.body.payment as { id: string; total_cents: string; lines: Array<{ kind: string; adjustment_id: string | null }> } | undefined;
  const oneAdj = one.body.allowance as { id: string; type: string; applied_payment_id: string | null } | null;
  const oneRet = one.body.return as { status: string; confirmation_number: string; filed_amount_cents: string } | null;
  check("un paso → 201 con pago, allowance y return", one.status === 201 && !!onePay && !!oneAdj && !!oneRet, JSON.stringify(one.body).slice(0, 200));
  if (onePay && oneAdj && oneRet) {
    check("allowance creado (STA) y aplicado al pago", oneAdj.type === "collection_allowance" && onePay.lines.some((l) => l.kind === "adjustment" && l.adjustment_id === oneAdj.id));
    check("total = tax − 30", BigInt(onePay.total_cents) === taxCents - 3000n, onePay.total_cents);
    check("return filed con la confirmación del DOR y el monto pagado", oneRet.status === "filed" && oneRet.confirmation_number === "DOR-CONF-77" && oneRet.filed_amount_cents === onePay.total_cents, JSON.stringify(oneRet));
    const v1 = await call(`/admin/accounting/sales-tax/payments/${onePay.id}/void`, { method: "POST", token, body: { reason: "e2e" }, pin });
    const v2 = await call(`/admin/accounting/sales-tax/adjustments/${oneAdj.id}/void`, { method: "POST", token, body: { reason: "e2e" }, pin });
    const r2 = await call(`/admin/accounting/sales-tax/periods/${PERIOD}/reopen`, { method: "POST", token, body: {}, pin });
    check("limpieza: void pago + void allowance + reopen", v1.status === 200 && v2.status === 200 && r2.status === 200, `${v1.status} ${v2.status} ${r2.status}`);
  }

  // ── 7 · negativos ─────────────────────────────────────────────────────────
  console.log("\n§7 negativos");
  check("pos_invoice intacto", (await count(`SELECT COUNT(*)::text AS n FROM pos_invoice WHERE deleted_at IS NULL`)) === invoicesBefore);
  check("gl_check intacto", (await count(`SELECT COUNT(*)::text AS n FROM gl_check WHERE deleted_at IS NULL`)) === checksBefore);
  check("el saldo del payable volvió al inicial", (await payableBalance()) === balanceBefore, `${balanceBefore} → ${await payableBalance()}`);
  const final = await call(`/admin/accounting/sales-tax/periods/${PERIOD}`, { token });
  const finalLive = final.body.live as { return_status: string; payment_status: string };
  check("período vuelve a open / unpaid", finalLive.return_status === "open" && finalLive.payment_status === "unpaid");

  await db.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "✅" : "❌"} e2e-sales-tax-sandbox: ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
