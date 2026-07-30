/**
 * E2E — borrado de un vendor bill ADOPTADO — SANDBOX ONLY.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * `verify-adopted-bill-unadopt.ts` es estático: comprueba que el guard esté
 * escrito y que el modal diga lo que tiene que decir. No puede probar el EFECTO,
 * que es lo único que el operador va a mirar: que el PO quede libre para
 * facturarse otra vez.
 *
 * Y hay una forma de fallar que ningún gate estático ve. Las rutas de QB le pasan
 * al helper del PIN un `Client` de pg envuelto en `pgAsPinConn`, por un cast que
 * el type-check no puede desmentir; `verifySupervisorPin` tiene `catch { return
 * false }`, o sea que un cast malo deja la operación RECHAZANDO SIEMPRE, en
 * producción, con todo en verde. Por eso un 403 con PIN equivocado no prueba
 * nada: lo que prueba es que el PIN CORRECTO sea aceptado y que el efecto ocurra.
 *
 * ── Qué cubre ─────────────────────────────────────────────────────────────────
 *  0. CONTROL POSITIVO: el PO elegido aparece en la cola de POs facturables
 *     ANTES de sembrar, y desaparece al sembrar el bill adoptado. Sin esto, un
 *     "el PO volvió a la cola" al final podría ser un endpoint que devuelve todo.
 *  1. PIN equivocado → 403 y el bill SIGUE VIVO.
 *  2. PIN correcto → 200 · el bill queda soft-deleted con nota de auditoría · el
 *     PO vuelve a la cola con billed_status 'no' · el TxnID de QuickBooks vuelve
 *     a estar libre para re-parearse.
 *  3. Un adopted pagado por un wire CONFIRMADO → 409 on_confirmed_wire y el bill
 *     sigue vivo (el guard bloqueó; no se borró "de casualidad").
 *  4. Un adopted con cost events posteados → 409 bill_has_posted_costs, ídem.
 *
 * QuickBooks NO se toca en ningún caso: la ruta sólo borra el espejo local, y en
 * el sandbox el bridge está apagado de todos modos.
 *
 * ── Cómo correrlo ─────────────────────────────────────────────────────────────
 *   ./back-sb                       # backend sandbox en :9099
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-adopted-bill-unadopt-sandbox.ts
 */
import { Client } from "pg";

// ── Guards fail-closed ───────────────────────────────────────────────────────
// Este script SIEMBRA vendor bills y wires, y falla el PIN a propósito (lo que
// bloquea al usuario 15 minutos). El snapshot del sandbox trae los MISMOS user
// ids que producción, así que el destino no se infiere: se exige.
const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

/** Prefijo único de todo lo que este test crea — hace el cleanup trivial e idempotente. */
const TAG = "_e2e_unadopt_";

function abort(why: string): never {
  console.error(`\n❌ ABORTADO: ${why}\n`);
  process.exit(2);
}

if (!/^http:\/\/(localhost|127\.0\.0\.1):9099(\/|$)/.test(BASE)) {
  abort(
    `BASE apunta a ${BASE}. Este script SOLO corre contra el backend sandbox en ` +
      `localhost:9099 — siembra documentos y falla el PIN a propósito.`
  );
}
if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  abort(
    `la DB no es la del sandbox (se esperaba localhost:5499). Sembrar vendor ` +
      `bills y wires en la base equivocada es exactamente lo que este guard impide.`
  );
}

// ── Mini framework ───────────────────────────────────────────────────────────
const results: Array<{ ok: boolean; name: string; detail: string }> = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail}`}`);
}

interface Resp {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}
async function call(
  path: string,
  opts: { token: string; body?: Record<string, unknown>; pin?: string; method?: string }
): Promise<Resp> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.token}`,
  };
  if (opts.pin !== undefined) headers["x-supervisor-pin"] = opts.pin;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* respuesta no-JSON: `raw` queda para el diagnóstico */
  }
  return { status: res.status, body, raw };
}

/** Un PIN equivocado que jamás pueda coincidir con el real, sea cual sea. */
function wrongPinFor(real: string): string {
  const candidate = "0".repeat(Math.max(real.length, 4));
  return candidate === real ? "1".repeat(candidate.length) : candidate;
}

interface QueuePo {
  po_id: string;
  number: string;
  billed_status: string;
}
interface QueueVendor {
  pos: QueuePo[];
}

/** Busca un PO en la cola de "POs facturables" tal como la ve la pantalla. */
async function findInQueue(token: string, poId: string): Promise<QueuePo | null> {
  const r = await call("/admin/quickbooks/bill-match/unbilled-pos", { token, method: "GET" });
  if (r.status !== 200) {
    abort(`unbilled-pos devolvió ${r.status}: ${r.raw.slice(0, 200)}`);
  }
  const vendors = (r.body.vendors ?? []) as QueueVendor[];
  for (const v of vendors) {
    for (const p of v.pos ?? []) if (p.po_id === poId) return p;
  }
  return null;
}

async function cleanup(db: Client): Promise<void> {
  // Orden inverso a las dependencias. Son filas propias del test, creadas con
  // ids que llevan el TAG: un DELETE por prefijo no puede alcanzar nada ajeno.
  await db.query(`DELETE FROM china_wire_transfer_application WHERE id LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM china_finance_bill WHERE id LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM china_wire_transfer WHERE id LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM variant_cost_event WHERE id LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM vendor_bill WHERE id LIKE $1`, [`%${TAG}%`]);
}

/** Siembra un bill adoptado header-only (cero líneas), como los reales. */
async function seedAdopted(
  db: Client,
  suffix: string,
  poId: string,
  vendorId: string | null
): Promise<{ id: string; txnId: string }> {
  const id = `vb${TAG}${suffix}`;
  const txnId = `txn${TAG}${suffix}`;
  await db.query(
    `INSERT INTO vendor_bill
       (id, purchase_order_id, vendor_id, bill_type, reference_id, status,
        qb_txn_id, qb_source, document_date, created_at, updated_at)
     VALUES ($1, $2, $3, 'regular', $4, 'synced', $5, 'adopted', NOW(), NOW(), NOW())`,
    [id, poId, vendorId, `E2E-${suffix}`, txnId]
  );
  return { id, txnId };
}

/** El predicado EXACTO con el que `candidates-by-vendor` decide "ya adoptado". */
async function txnIsClaimed(db: Client, txnId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT vb.id FROM vendor_bill vb
      WHERE vb.qb_txn_id = ANY($1::text[]) AND vb.deleted_at IS NULL`,
    [[txnId]]
  );
  return rows.length > 0;
}

async function main(): Promise<void> {
  console.log("=== e2e-adopted-bill-unadopt (sandbox) ===\n");

  const db = new Client({ connectionString: SB_DB });
  await db.connect();
  await cleanup(db); // por si una corrida anterior murió a mitad

  // ── PIN real (nunca se imprime) ────────────────────────────────────────────
  const { rows: storeRows } = await db.query<{ pin: string | null }>(
    `SELECT metadata->>'pos_supervisor_pin' AS pin FROM store
      WHERE metadata->>'pos_supervisor_pin' IS NOT NULL ORDER BY id LIMIT 1`
  );
  const realPin = storeRows[0]?.pin;
  if (!realPin) {
    await db.end();
    abort(
      `el store del sandbox no tiene pos_supervisor_pin. Configurarlo por ` +
        `POST /admin/pos/supervisor-pin antes de correr esto.`
    );
  }
  const badPin = wrongPinFor(realPin);
  console.log(`  · PIN del sandbox: presente (${realPin.length} dígitos, no se imprime)`);

  // ── Login ──────────────────────────────────────────────────────────────────
  const email = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
  const password = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const auth = (await authRes.json().catch(() => ({}))) as { token?: string };
  if (!auth.token) {
    await db.end();
    abort(
      `no se pudo loguear como ${email} (HTTP ${authRes.status}). Ver la sección ` +
        `de usuario de test en docs/SANDBOX.md — un reset del sandbox lo borra.`
    );
  }
  const token = auth.token;

  // ── POs de trabajo: recibidos y sin ningún bill vivo ───────────────────────
  const { rows: poRows } = await db.query<{
    id: string;
    number: string;
    vendor_id: string | null;
  }>(
    `SELECT po.id, po.number, po.vendor_id
       FROM purchase_order po
      WHERE po.deleted_at IS NULL AND po.total_units_received > 0
        AND NOT EXISTS (
          SELECT 1 FROM vendor_bill vb
           WHERE vb.purchase_order_id = po.id AND vb.deleted_at IS NULL)
      ORDER BY po.number DESC LIMIT 3`
  );
  if (poRows.length < 3) {
    await db.end();
    abort(
      `hacen falta 3 POs recibidos y sin facturar en el sandbox; hay ${poRows.length}. ` +
        `Refrescar el snapshot del sandbox.`
    );
  }
  const [poMain, poWire, poCost] = poRows as [
    { id: string; number: string; vendor_id: string | null },
    { id: string; number: string; vendor_id: string | null },
    { id: string; number: string; vendor_id: string | null },
  ];
  console.log(`  · POs de trabajo: ${poMain.number} · ${poWire.number} · ${poCost.number}\n`);

  try {
    // ═══ 0 · CONTROL POSITIVO ══════════════════════════════════════════════
    // Sin esto, el assert final ("el PO volvió a la cola") pasaría igual con un
    // endpoint que devuelve todos los POs siempre. Hay que ver la cola MOVERSE.
    console.log("0 · control positivo — la cola reacciona al estado");
    check(
      `${poMain.number} está en la cola ANTES de sembrar`,
      (await findInQueue(token, poMain.id)) !== null,
      `el PO no aparece en unbilled-pos ni sin bills: el assert final no probaría nada`
    );

    const billA = await seedAdopted(db, "main", poMain.id, poMain.vendor_id);
    check(
      `${poMain.number} SALE de la cola al sembrar el adopted`,
      (await findInQueue(token, poMain.id)) === null,
      `un adopted sin líneas debe contar como PO totalmente facturado y sacarlo ` +
        `de la cola; si sigue ahí, el resto del test mide otra cosa`
    );
    check(
      "el TxnID de QuickBooks queda reclamado por el espejo",
      await txnIsClaimed(db, billA.txnId),
      "el predicado de adopción no ve el bill recién sembrado"
    );

    // ═══ 1 · PIN equivocado ════════════════════════════════════════════════
    console.log("\n1 · PIN equivocado → rechazo, y el bill sigue vivo");
    const bad = await call("/admin/quickbooks/bill-match/undo", {
      token,
      body: { vendor_bill_id: billA.id },
      pin: badPin,
    });
    check(
      "PIN equivocado → 403",
      bad.status === 403 && bad.body.code === "INVALID_SUPERVISOR_PIN",
      `dio ${bad.status} ${bad.raw.slice(0, 160)}`
    );
    const { rows: aliveRows } = await db.query(
      `SELECT deleted_at FROM vendor_bill WHERE id = $1`,
      [billA.id]
    );
    check(
      "el bill NO se borró con el PIN equivocado",
      (aliveRows[0] as { deleted_at: Date | null } | undefined)?.deleted_at === null,
      "el rechazo fue cosmético: el bill quedó borrado igual"
    );

    // ═══ 2 · PIN correcto → el efecto ══════════════════════════════════════
    console.log("\n2 · PIN correcto → el bill se va y el PO vuelve a ser facturable");
    const ok = await call("/admin/quickbooks/bill-match/undo", {
      token,
      body: { vendor_bill_id: billA.id, reason: "e2e" },
      pin: realPin,
    });
    check(
      "PIN correcto → 200 (prueba que pgAsPinConn sirve)",
      ok.status === 200 && ok.body.success === true,
      `dio ${ok.status} ${ok.raw.slice(0, 200)} — si es 403 con el PIN bueno, el ` +
        `gate está fallando CERRADO y rechazaría todo en producción`
    );

    const { rows: goneRows } = await db.query<{ deleted_at: Date | null; notes: string | null }>(
      `SELECT deleted_at, notes FROM vendor_bill WHERE id = $1`,
      [billA.id]
    );
    const gone = goneRows[0];
    check(
      "el bill quedó soft-deleted",
      gone?.deleted_at !== null && gone?.deleted_at !== undefined,
      "la fila sigue viva después de un 200"
    );
    check(
      "quedó la nota de auditoría de quién lo borró",
      typeof gone?.notes === "string" && gone.notes.includes("[UNDONE by "),
      `notes = ${String(gone?.notes).slice(0, 120)}`
    );
    const queueAfter = await findInQueue(token, poMain.id);
    check(
      `${poMain.number} VOLVIÓ a la cola de facturables`,
      queueAfter !== null,
      "el PO sigue contando como facturado: borrar el bill no lo liberó"
    );
    check(
      `${poMain.number} volvió con billed_status 'no'`,
      queueAfter?.billed_status === "no",
      `billed_status = ${String(queueAfter?.billed_status)}`
    );
    check(
      "el TxnID de QuickBooks quedó libre para re-parearse",
      !(await txnIsClaimed(db, billA.txnId)),
      "el espejo borrado sigue reclamando el TxnID: el bill de QB no se podría re-parear"
    );

    // ═══ 3 · acoplado a un wire CONFIRMADO ═════════════════════════════════
    console.log("\n3 · adopted pagado por un wire confirmado → 409, y sigue vivo");
    const billB = await seedAdopted(db, "wire", poWire.id, poWire.vendor_id);
    await db.query(
      `INSERT INTO china_wire_transfer (id, status, wire_amount_cents, created_at, updated_at)
       VALUES ($1, 'confirmed', 100000, NOW(), NOW())`,
      [`cwt${TAG}wire`]
    );
    await db.query(
      `INSERT INTO china_finance_bill
         (id, type, document_type, vendor_bill_id, amount_cents, created_at, updated_at)
       VALUES ($1, 'vendor_bill', 'commercial_invoice', $2, 100000, NOW(), NOW())`,
      [`cfb${TAG}wire`, billB.id]
    );
    await db.query(
      `INSERT INTO china_wire_transfer_application
         (id, wire_transfer_id, bill_id, applied_cents, created_at, updated_at)
       VALUES ($1, $2, $3, 100000, NOW(), NOW())`,
      [`cwta${TAG}wire`, `cwt${TAG}wire`, `cfb${TAG}wire`]
    );

    const wireResp = await call("/admin/quickbooks/bill-match/undo", {
      token,
      body: { vendor_bill_id: billB.id },
      pin: realPin,
    });
    check(
      "wire confirmado → 409 on_confirmed_wire",
      wireResp.status === 409 && wireResp.body.error === "on_confirmed_wire",
      `dio ${wireResp.status} ${wireResp.raw.slice(0, 200)}`
    );
    const { rows: bAlive } = await db.query(
      `SELECT deleted_at FROM vendor_bill WHERE id = $1`,
      [billB.id]
    );
    check(
      "el bill acoplado al wire sigue vivo",
      (bAlive[0] as { deleted_at: Date | null } | undefined)?.deleted_at === null,
      "el 409 no impidió el borrado — la aplicación del wire quedó huérfana"
    );

    // ═══ 4 · con cost events posteados ═════════════════════════════════════
    console.log("\n4 · adopted con costos posteados → 409, y sigue vivo");
    const billC = await seedAdopted(db, "cost", poCost.id, poCost.vendor_id);
    const { rows: variantRows } = await db.query<{ id: string }>(
      `SELECT id FROM product_variant WHERE deleted_at IS NULL ORDER BY id LIMIT 1`
    );
    const variantId = variantRows[0]?.id;
    if (!variantId) abort("no hay ninguna product_variant en el sandbox.");
    await db.query(
      // `variant_cost_event` es append-only: no tiene `updated_at`. Un evento de
      // costo no se edita, se supersede — de ahí `supersedes_event_id`.
      `INSERT INTO variant_cost_event
         (id, product_variant_id, event_type, effective_at, vendor_bill_id, created_at)
       VALUES ($1, $2, 'vendor_bill_receipt', NOW(), $3, NOW())`,
      [`vce${TAG}cost`, variantId, billC.id]
    );

    const costResp = await call("/admin/quickbooks/bill-match/undo", {
      token,
      body: { vendor_bill_id: billC.id },
      pin: realPin,
    });
    check(
      "cost events → 409 bill_has_posted_costs",
      costResp.status === 409 && costResp.body.error === "bill_has_posted_costs",
      `dio ${costResp.status} ${costResp.raw.slice(0, 200)}`
    );
    const { rows: cAlive } = await db.query(
      `SELECT deleted_at FROM vendor_bill WHERE id = $1`,
      [billC.id]
    );
    check(
      "el bill con costos posteados sigue vivo",
      (cAlive[0] as { deleted_at: Date | null } | undefined)?.deleted_at === null,
      "el 409 no impidió el borrado — quedaron cost events apuntando a un bill inexistente"
    );
  } finally {
    await cleanup(db);
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n── ${results.length - failed.length}/${results.length} OK ──`);
  if (failed.length > 0) {
    console.log("\nFALLARON:");
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
    console.log("");
    process.exit(1);
  }
  console.log("\n✅ el borrado de un adopted es real, gateado, y libera el PO\n");
}

void main();
