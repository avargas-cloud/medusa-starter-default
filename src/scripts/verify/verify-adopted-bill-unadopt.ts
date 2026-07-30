/**
 * verify-adopted-bill-unadopt
 *
 * Proves an ADOPTED vendor bill can be removed from Store POS — PIN-gated, local
 * only — and that removing it actually frees its Purchase Order to be billed again.
 *
 * WHY THIS EXISTS
 * The capability already lived in the backend (`POST /admin/quickbooks/bill-match/undo`,
 * soft delete + supervisor PIN + throttle) but was UNREACHABLE for the case that
 * needs it most. Its only caller was the Match QB Bills screen, which lists bills
 * that QuickBooks returns for a vendor — so an adopted bill whose QB document was
 * already deleted never appeared there and could not be removed by anyone.
 * Measured live: FTL - 1573151 / PO-1117 (ELA Florida), stuck exactly that way.
 * Meanwhile `DELETE /admin/vendor-bills/:id` rejects every adopted bill by design
 * (status is 'synced' and `qb_txn_id` is present).
 *
 * WHAT IT CHECKS
 *   1. The undo route refuses a bill that is coupled to money already moved
 *      (posted cost events, or an application on a CONFIRMED wire). Without this,
 *      removing the bill would orphan a wire application: money pointing at a
 *      row that no longer exists.
 *   2. The POS detail page reaches the route for adopted bills, and its modal
 *      states the three things the operator must know before pressing: what is
 *      removed, that QuickBooks is NOT touched, and what is left to do in QB.
 *      Owner-stated requirement (2026-07-30) — asserted so an edit can't drop it.
 *   3. The re-match path is real: adoption is detected with `deleted_at IS NULL`,
 *      so a soft-deleted mirror releases its QB bill to be matched again.
 *   4. LIVE (read-only): the invariant the guard rests on — no adopted bill today
 *      carries cost events or a confirmed-wire application. If this stops being
 *      true, the guard starts rejecting and that is worth knowing before an
 *      operator meets it as a 409.
 *
 * The PIN gate itself is asserted by `verify-pin-enforcement.ts`, which already
 * names this route in MUST_GATE_ROUTES. Not duplicated here.
 *
 * RUN
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-adopted-bill-unadopt.ts
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { Client } from "pg";

const BACKEND_SRC = join(process.cwd(), "src");
const POS_ROOT = join(process.cwd(), "..", "store-pos");

const failures: string[] = [];
const notes: string[] = [];

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// ── 1 · el guard de acoplamiento existe en la ruta ───────────────────────────
/**
 * Un ✓ impreso al lado de la falla de su propio chequeo es peor que no imprimir
 * nada: enseña a leer la lista de notas como aprobación. Cada chequeo mide su
 * propio delta de fallas antes de anotarse el visto bueno.
 */
function noteIfClean(before: number, note: string): void {
  if (failures.length === before) notes.push(note);
}

function checkCouplingGuard(): void {
  const before = failures.length;
  const rel = "api/admin/quickbooks/bill-match/undo/route.ts";
  const src = read(join(BACKEND_SRC, rel));
  if (src === null) {
    failures.push(
      `${rel} no existe donde se esperaba. Si se movió, actualizar este ` +
        `verificador Y verify-pin-enforcement.ts: los dos la afirman por nombre.`
    );
    return;
  }

  const wants: Array<[string, string]> = [
    [
      "variant_cost_event",
      "no consulta variant_cost_event — un bill que posteó costos se borraría " +
        "dejando esos costos aplicados sin nada que los explique",
    ],
    [
      "china_wire_transfer_application",
      "no consulta las aplicaciones de wire — un bill pagado por un wire " +
        "confirmado se borraría y dejaría la aplicación apuntando a un bill inexistente",
    ],
    ["on_confirmed_wire", "no devuelve el código on_confirmed_wire"],
    ["bill_has_posted_costs", "no devuelve el código bill_has_posted_costs"],
  ];
  for (const [needle, why] of wants) {
    if (!src.includes(needle)) failures.push(`${rel} ${why}.`);
  }

  // El wire tiene que filtrarse por 'confirmed': bloquear también los scheduled
  // haría inborrable un bill que nadie pagó todavía.
  if (!/cwt\.status\s*=\s*'confirmed'/.test(src)) {
    failures.push(
      `${rel} no filtra el wire por status='confirmed'. Un wire scheduled no es ` +
        `plata movida: bloquear por él haría inborrable un bill que nadie pagó.`
    );
  }
  noteIfClean(before, "✓ la ruta undo rechaza acoplamiento a dinero ya movido");
}

// ── 2 · el POS llega a la ruta, y su modal dice las tres cosas ───────────────
function checkPosWiring(): void {
  const before = failures.length;
  const rel = "app/(pos)/vendor-bills/[id]/page.tsx";
  const src = read(join(POS_ROOT, rel));
  if (src === null) {
    failures.push(`store-pos/${rel} no existe donde se esperaba — actualizar este verificador.`);
    return;
  }

  if (!src.includes("undoAdopt")) {
    failures.push(
      `store-pos/${rel} no llama a undoAdopt(): sin eso el único camino para ` +
        `borrar un adopted vuelve a ser la pantalla Match QB Bills, que no lista ` +
        `los bills cuyo documento de QuickBooks ya no existe.`
    );
  }
  if (!/isAdopted[\s\S]{0,200}setUnadoptConfirmOpen/.test(src)) {
    failures.push(
      `store-pos/${rel} no expone el borrado para bills adoptados (falta la rama ` +
        `isAdopted → setUnadoptConfirmOpen en el toolbar).`
    );
  }

  // Los tres hechos que el owner pidió que el modal declare explícitamente.
  const claims: Array<[RegExp, string]> = [
    [/does NOT delete the bill in QuickBooks/i, "que NO borra el bill en QuickBooks"],
    [/billable again/i, "que el PO vuelve a ser facturable"],
    [/deleted there[\s\S]{0,200}re-linked|re-linked[\s\S]{0,200}deleted there/i,
      "que si el bill sigue en QuickBooks hay que borrarlo allá o re-enlazarlo"],
  ];
  for (const [re, what] of claims) {
    if (!re.test(src)) {
      failures.push(
        `store-pos/${rel}: el modal de confirmación ya no dice ${what}. Es requisito ` +
          `del owner (2026-07-30): sin esa frase el operador cree que borró el ` +
          `documento contable del accountant.`
      );
    }
  }
  noteIfClean(before, "✓ el POS llega a la ruta y su modal declara los 3 hechos");
}

// ── 3 · el camino de re-match sigue siendo real ──────────────────────────────
function checkRematchPath(): void {
  const rel = "api/admin/quickbooks/bill-match/candidates-by-vendor/route.ts";
  const src = read(join(BACKEND_SRC, rel));
  if (src === null) {
    failures.push(`${rel} no existe donde se esperaba — actualizar este verificador.`);
    return;
  }
  // El "ya está adoptado" de un bill de QB se decide por la existencia de un
  // espejo VIVO. Si esa query dejara de filtrar por deleted_at, un espejo
  // borrado seguiría reclamando el TxnID y el bill nunca volvería a ser
  // adoptable — el borrado quedaría sin su mitad útil.
  if (!/qb_txn_id\s*=\s*ANY\([\s\S]{0,80}deleted_at IS NULL/.test(src)) {
    failures.push(
      `${rel} ya no resuelve "bill adoptado" con qb_txn_id = ANY(...) AND ` +
        `deleted_at IS NULL. Sin ese filtro, borrar el espejo NO libera el bill ` +
        `de QuickBooks para re-parearlo, que es la mitad del sentido de borrarlo.`
    );
    return;
  }
  notes.push("✓ borrar el espejo devuelve su bill de QB al pool adoptable");
}

// ── 4 · el invariante vivo sobre el que descansa el guard ────────────────────
async function checkLiveInvariant(client: Client): Promise<void> {
  const { rows } = await client.query<{
    adopted: string;
    with_cost_events: string;
    with_confirmed_wire: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM vendor_bill
         WHERE qb_source = 'adopted' AND deleted_at IS NULL) AS adopted,
       (SELECT COUNT(DISTINCT vb.id) FROM vendor_bill vb
          JOIN variant_cost_event vce ON vce.vendor_bill_id = vb.id
         WHERE vb.qb_source = 'adopted' AND vb.deleted_at IS NULL) AS with_cost_events,
       (SELECT COUNT(DISTINCT vb.id) FROM vendor_bill vb
          JOIN china_finance_bill cfb ON cfb.vendor_bill_id = vb.id
          JOIN china_wire_transfer_application cwta ON cwta.bill_id = cfb.id
          JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
         WHERE vb.qb_source = 'adopted' AND vb.deleted_at IS NULL
           AND cwt.status = 'confirmed') AS with_confirmed_wire`
  );
  const r = rows[0];
  if (!r) {
    failures.push("la query del invariante vivo no devolvió filas — revisar la conexión.");
    return;
  }
  const coupled = Number(r.with_cost_events) + Number(r.with_confirmed_wire);
  notes.push(
    `· ${r.adopted} adopted vivos · ${r.with_cost_events} con cost events · ` +
      `${r.with_confirmed_wire} con wire confirmado`
  );
  if (coupled > 0) {
    notes.push(
      `⚠ ${coupled} adopted acoplados a dinero ya movido: para ésos el guard ` +
        `responde 409 y hay que revertir el pago o cancelar antes de borrarlos. ` +
        `No es una falla — es el guard haciendo su trabajo.`
    );
  }
}

async function main(): Promise<void> {
  checkCouplingGuard();
  checkPosWiring();
  checkRematchPath();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    failures.push(
      "DATABASE_URL ausente: los chequeos estáticos corrieron pero el invariante " +
        "vivo no. Un verificador a medias que sale 0 es peor que uno que falla."
    );
  } else {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await checkLiveInvariant(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  console.log("\n── verify-adopted-bill-unadopt ──");
  for (const n of notes) console.log(`  ${n}`);
  if (failures.length > 0) {
    console.log("\n  FALLAS:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log("");
    process.exit(1);
  }
  console.log("\n  PASS\n");
}

void main();
