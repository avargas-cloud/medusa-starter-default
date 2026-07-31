/**
 * Repara el split invertido de VB-1053 / V260706-I1 (china-finance).
 *
 * ── Qué pasó ─────────────────────────────────────────────────────────────────
 * El bill se pagó ENTERO ($3.763,37, wire confirmado el 2026-07-27). El
 * 2026-07-30 un ajuste contra el receipt lo subió a $3.775,15, así que quedaron
 * $11,78 abiertos. Al agendarlos en el wire draft del 2026-08-03, el modal
 * comparó $11,78 contra el importe COMPLETO en vez de contra el saldo, lo llamó
 * pago parcial, y `splitBillForPartialPayment` partió el bill como si no se
 * hubiera pagado nada:
 *
 *   raíz  bf3fc223…  $3.775,15 → $11,78     ← se quedó con el pago confirmado
 *   hija  f9b52098…  (nueva)     $3.763,37  ← plata YA PAGADA, facturada de nuevo
 *
 * En pantalla: un `CREDIT +$3.751,59` que nadie debe (el confirmado excede al
 * importe encogido) y una deuda vencida de $3.763,37 que ya se pagó. Los dos
 * errores son la misma cifra con signo opuesto, así que el balance del ledger
 * cerraba en $0,00 y nada avisó.
 *
 * ── Qué hace ─────────────────────────────────────────────────────────────────
 * Deja UNA fila de $3.775,15 sin partir, con sus DOS aplicaciones intactas:
 * $3.763,37 confirmada + $11,78 en el draft. Saldo resultante: $11,78.
 *
 * NO TOCA `china_wire_transfer_application` NI `china_wire_transfer`. Esa es la
 * propiedad que hace segura la reparación: la plata no se mueve, sólo se
 * reconstruye la fila a la que pertenece. El wire del 2026-08-03 sigue cuadrando
 * en $6.316,72 = Σ aplicado.
 *
 * ── Cómo correrlo ────────────────────────────────────────────────────────────
 *   # 1) Dry-run (default): imprime estado, precondiciones y el compensatorio.
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/migrations/repair-v260706-i1-split.ts
 *
 *   # 2) Aplicar (una transacción).
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" REPAIR_APPLY=yes \
 *     ./node_modules/.bin/tsx src/scripts/migrations/repair-v260706-i1-split.ts
 *
 * Idempotente: si el estado ya es el reparado, informa y sale 0 sin escribir.
 */
import { Client } from "pg";

const ROOT_ID = "bf3fc223-0fdc-4455-a230-c37cf7964767";
const CHILD_ID = "f9b52098-ccd8-4174-b533-ccb152b27d24";

/** El importe correcto del bill tras el ajuste del receipt. */
const CORRECT_AMOUNT_CENTS = 377515;
/** Lo que la hija se llevó por error — exactamente lo ya pagado y confirmado. */
const CHILD_AMOUNT_CENTS = 376337;
/** Lo que la raíz quedó valiendo tras el split invertido. */
const BROKEN_ROOT_AMOUNT_CENTS = 1178;

const APPLY = process.env.REPAIR_APPLY === "yes";

interface BillRow {
  id: string;
  invoice_number: string | null;
  vendor_bill_id: string | null;
  amount_cents: number;
  split_group_id: string | null;
  partial_seq: number | null;
  split_version: number;
  document_date: string | null;
  due_date: string | null;
  type: string | null;
  sort_order: number;
  document_type: string;
  po_number: string | null;
  po_ref_number: string | null;
  payee: string | null;
  description: string | null;
  wire_transfer_id: string | null;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fail(why: string): never {
  console.error(`\n❌ ABORTADO — ${why}\n`);
  process.exit(1);
}

async function readBills(db: Client): Promise<BillRow[]> {
  const { rows } = await db.query<BillRow>(
    `SELECT id, invoice_number, vendor_bill_id, amount_cents, split_group_id,
            partial_seq, split_version, document_date::text AS document_date,
            due_date::text AS due_date, type, sort_order, document_type,
            po_number, po_ref_number, payee, description, wire_transfer_id
       FROM china_finance_bill
      WHERE id = $1 OR id = $2 OR split_group_id = $1
      ORDER BY partial_seq NULLS FIRST`,
    [ROOT_ID, CHILD_ID]
  );
  return rows;
}

async function readApps(
  db: Client
): Promise<Array<{ id: string; bill_id: string; applied_cents: number; wire_status: string; sent_date: string | null }>> {
  const { rows } = await db.query<{
    id: string;
    bill_id: string;
    applied_cents: number;
    wire_status: string;
    sent_date: string | null;
  }>(
    `SELECT a.id, a.bill_id, a.applied_cents, w.status AS wire_status,
            w.sent_date::text AS sent_date
       FROM china_wire_transfer_application a
       JOIN china_wire_transfer w ON w.id = a.wire_transfer_id
      WHERE a.bill_id = $1 OR a.bill_id = $2
      ORDER BY w.status, a.id`,
    [ROOT_ID, CHILD_ID]
  );
  return rows;
}

function printState(label: string, bills: BillRow[], apps: Awaited<ReturnType<typeof readApps>>): void {
  console.log(`\n── ${label} ──`);
  for (const b of bills) {
    console.log(
      `  bill ${b.id.slice(0, 8)}…  ${b.invoice_number}  ${money(b.amount_cents).padStart(10)}  ` +
        `group=${b.split_group_id ? b.split_group_id.slice(0, 8) + "…" : "—"}  seq=${b.partial_seq ?? "—"}  ` +
        `vendor_bill=${b.vendor_bill_id ?? "—"}`
    );
  }
  for (const a of apps) {
    console.log(
      `  app  ${a.id.slice(0, 8)}…  bill=${a.bill_id.slice(0, 8)}…  ${money(a.applied_cents).padStart(10)}  ` +
        `wire=${a.wire_status}${a.sent_date ? ` (${a.sent_date})` : ""}`
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) fail("falta DATABASE_URL (pasarla explícita — el shell filtra una que pega a la DB equivocada)");

  const db = new Client({ connectionString: url });
  await db.connect();

  console.log(`\nReparación VB-1053 / V260706-I1 — modo ${APPLY ? "APLICAR" : "DRY-RUN"}`);

  const before = await readBills(db);
  const appsBefore = await readApps(db);
  printState("ESTADO ACTUAL", before, appsBefore);

  // ── Idempotencia ──────────────────────────────────────────────────────────
  const alreadyFixed =
    before.length === 1 &&
    before[0]!.id === ROOT_ID &&
    before[0]!.amount_cents === CORRECT_AMOUNT_CENTS &&
    before[0]!.split_group_id === null &&
    before[0]!.partial_seq === null;
  if (alreadyFixed) {
    console.log("\n✅ Ya está reparado (una fila, sin partir, importe correcto). No se escribe nada.");
    await db.end();
    return;
  }

  // ── Precondiciones ────────────────────────────────────────────────────────
  // Cada una nombra lo que se esperaba. Si el estado se movió desde que se
  // diagnosticó, este script NO adivina: se detiene.
  const root = before.find((b) => b.id === ROOT_ID);
  const child = before.find((b) => b.id === CHILD_ID);

  if (before.length !== 2) fail(`se esperaban 2 filas en el grupo, hay ${before.length}`);
  if (!root) fail(`no existe la fila raíz ${ROOT_ID}`);
  if (!child) fail(`no existe la fila hija ${CHILD_ID}`);
  if (root.amount_cents !== BROKEN_ROOT_AMOUNT_CENTS) {
    fail(`la raíz vale ${money(root.amount_cents)}, se esperaba ${money(BROKEN_ROOT_AMOUNT_CENTS)}`);
  }
  if (child.amount_cents !== CHILD_AMOUNT_CENTS) {
    fail(`la hija vale ${money(child.amount_cents)}, se esperaba ${money(CHILD_AMOUNT_CENTS)}`);
  }
  if (root.amount_cents + child.amount_cents !== CORRECT_AMOUNT_CENTS) {
    fail(
      `la suma del grupo es ${money(root.amount_cents + child.amount_cents)}, ` +
        `se esperaba ${money(CORRECT_AMOUNT_CENTS)}`
    );
  }
  if (child.vendor_bill_id !== null) fail("la hija tiene vendor_bill_id — no es la fila que creó el split");
  if (root.vendor_bill_id === null) fail("la raíz perdió su vendor_bill_id — estado inesperado");

  const childApps = appsBefore.filter((a) => a.bill_id === CHILD_ID);
  if (childApps.length !== 0) {
    fail(`la hija tiene ${childApps.length} aplicación(es) de wire — borrarla movería dinero. NO se toca.`);
  }
  const rootApps = appsBefore.filter((a) => a.bill_id === ROOT_ID);
  const confirmed = rootApps.filter((a) => a.wire_status === "confirmed");
  const confirmedCents = confirmed.reduce((n, a) => n + a.applied_cents, 0);
  if (confirmedCents !== CHILD_AMOUNT_CENTS) {
    fail(
      `la raíz tiene ${money(confirmedCents)} confirmados, se esperaba ${money(CHILD_AMOUNT_CENTS)} ` +
        `(la premisa entera es que la hija se llevó justo lo ya pagado)`
    );
  }

  console.log("\n✓ Precondiciones OK — el estado es exactamente el diagnosticado.");
  console.log(`\n  Resultado proyectado: UNA fila de ${money(CORRECT_AMOUNT_CENTS)}, sin partir.`);
  console.log(`  Aplicaciones intactas: ${money(confirmedCents)} confirmada + ${money(
    rootApps.filter((a) => a.wire_status === "draft").reduce((n, a) => n + a.applied_cents, 0)
  )} en draft.`);
  console.log(
    `  Saldo resultante: ${money(CORRECT_AMOUNT_CENTS - confirmedCents)} (lo que realmente se debe).`
  );

  // ── Compensatorio ─────────────────────────────────────────────────────────
  // Se imprime ANTES de escribir, con la fila hija completa, para que revertir
  // no dependa de que este script siga existiendo.
  console.log("\n── COMPENSATORIO (revierte exactamente esto) ──");
  console.log(
    `  UPDATE china_finance_bill SET amount_cents = ${BROKEN_ROOT_AMOUNT_CENTS}, ` +
      `split_group_id = '${ROOT_ID}', partial_seq = 1 WHERE id = '${ROOT_ID}';`
  );
  console.log(
    `  INSERT INTO china_finance_bill (id, type, sort_order, vendor_bill_id, wire_transfer_id,\n` +
      `    document_type, invoice_number, po_number, po_ref_number, payee, description,\n` +
      `    amount_cents, document_date, due_date, split_group_id, partial_seq, split_version)\n` +
      `  VALUES ('${child.id}', ${child.type === null ? "NULL" : `'${child.type}'`}, ${child.sort_order}, NULL, ` +
      `${child.wire_transfer_id === null ? "NULL" : `'${child.wire_transfer_id}'`}, '${child.document_type}', ` +
      `${child.invoice_number === null ? "NULL" : `'${child.invoice_number}'`}, ` +
      `${child.po_number === null ? "NULL" : `'${child.po_number}'`}, ` +
      `${child.po_ref_number === null ? "NULL" : `'${child.po_ref_number}'`}, ` +
      `${child.payee === null ? "NULL" : `'${child.payee.replace(/'/g, "''")}'`}, ` +
      `${child.description === null ? "NULL" : `'${child.description.replace(/'/g, "''")}'`}, ` +
      `${child.amount_cents}, '${child.document_date}', '${child.due_date}', '${child.split_group_id}', ` +
      `${child.partial_seq}, ${child.split_version});`
  );

  if (!APPLY) {
    console.log("\n🔍 DRY-RUN — no se escribió nada. Re-correr con REPAIR_APPLY=yes para aplicar.\n");
    await db.end();
    return;
  }

  // ── Aplicar ───────────────────────────────────────────────────────────────
  await db.query("BEGIN");
  try {
    const upd = await db.query(
      `UPDATE china_finance_bill
          SET amount_cents = $1, split_group_id = NULL, partial_seq = NULL,
              split_version = split_version + 1, updated_at = now()
        WHERE id = $2 AND amount_cents = $3`,
      [CORRECT_AMOUNT_CENTS, ROOT_ID, BROKEN_ROOT_AMOUNT_CENTS]
    );
    if (upd.rowCount !== 1) throw new Error(`el UPDATE de la raíz afectó ${upd.rowCount} filas, se esperaba 1`);

    const del = await db.query(
      `DELETE FROM china_finance_bill
        WHERE id = $1 AND amount_cents = $2
          AND NOT EXISTS (SELECT 1 FROM china_wire_transfer_application WHERE bill_id = $1)`,
      [CHILD_ID, CHILD_AMOUNT_CENTS]
    );
    if (del.rowCount !== 1) throw new Error(`el DELETE de la hija afectó ${del.rowCount} filas, se esperaba 1`);

    await db.query("COMMIT");
    console.log("\n✅ APLICADO (1 update + 1 delete, una transacción).");
  } catch (e) {
    await db.query("ROLLBACK");
    fail(`la transacción se revirtió entera: ${e instanceof Error ? e.message : String(e)}`);
  }

  const after = await readBills(db);
  const appsAfter = await readApps(db);
  printState("ESTADO FINAL", after, appsAfter);

  // Aserciones sobre el resultado, incluida la negativa que importa: el dinero
  // no se movió.
  const okRow =
    after.length === 1 &&
    after[0]!.amount_cents === CORRECT_AMOUNT_CENTS &&
    after[0]!.split_group_id === null &&
    after[0]!.partial_seq === null;
  const okApps =
    appsAfter.length === appsBefore.length &&
    appsAfter.every((a) => appsBefore.some((b) => b.id === a.id && b.applied_cents === a.applied_cents));
  console.log(`\n  ${okRow ? "✓" : "✗"} una sola fila, sin partir, ${money(CORRECT_AMOUNT_CENTS)}`);
  console.log(`  ${okApps ? "✓" : "✗"} ninguna aplicación de wire cambió`);
  if (!okRow || !okApps) process.exitCode = 1;

  await db.end();
}

void main();
