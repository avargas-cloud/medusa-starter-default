/**
 * verify-outsourced-services.ts — gate de Order Outsourced Services.
 *
 * Correr:
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-outsourced-services.ts
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-outsourced-services.ts
 *
 * Sin `DATABASE_URL` corre sólo los chequeos estáticos y lo DICE — un
 * verificador que saltea la mitad en silencio es peor que no tenerlo.
 *
 * Dos cosas que este archivo hace distinto del de comisiones, por lecciones
 * que ya costaron caro en este repo:
 *
 * - Las rutas que MUTAN se afirman por NOMBRE (`MUST_GATE_ROUTES`), no por que
 *   su texto mencione la clave. Un check que depende de que el archivo se
 *   acuerde de nombrar algo es ciego a la falla inversa: la ruta que debería
 *   pedir PIN y no nombra nada sale limpia (secrets.md, 5ª extensión).
 *
 * - "Llama a X" descarta las líneas de `import`. Un check sobre el archivo
 *   entero acepta el import y da verde con el guard sin invocar (secrets.md,
 *   6ª extensión).
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { Pool } from "pg";

import { accountAllowedForVendorBillType } from "../../lib/purchase-orders/vendor-bill-account-rules";
import {
  isOpen,
  SERVICE_STATES,
} from "../../lib/outsourced-services/transitions";

const ROOT = resolve(__dirname, "../../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Cuerpo del archivo sin las líneas de import: "llama a X" ≠ "importa X". */
function bodyWithoutImports(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*import\s/.test(l) && !/^\s*}\s*from\s+["']/.test(l))
    .join("\n");
}

/**
 * El cuerpo de CADA handler exportado, por separado.
 *
 * Mirar el archivo entero no alcanza y no es teórico: el mutation test lo
 * probó. `services/[serviceId]/route.ts` exporta POST y DELETE, así que
 * sacarle el PIN a UNO dejaba el regex matcheando por culpa del otro y las dos
 * mutaciones pasaban en verde. Un gate por archivo sobre un archivo con dos
 * puertas sólo puede afirmar que UNA está cerrada.
 *
 * Escanea hasta el próximo `export async function`, nunca una ventana fija.
 */
function handlerBodies(src: string): Map<string, string> {
  const body = bodyWithoutImports(src);
  const re = /export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE)\s*\(/g;
  const starts: Array<{ name: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    starts.push({ name: m[1] as string, at: m.index });
  }
  const out = new Map<string, string>();
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : body.length;
    out.set(s.name, body.slice(s.at, end));
  });
  return out;
}

/** Los métodos HTTP que mutan estado y por lo tanto exigen los dos guards. */
const MUTATING_METHODS = ["POST", "PATCH", "PUT", "DELETE"];

// ─── §1 · Estados ────────────────────────────────────────────────────────────
console.log("\n§1 · Máquina de estados");
{
  check(
    "no existe el estado `eligible` (no hay devengo en un subcontrato)",
    !(SERVICE_STATES as readonly string[]).includes("eligible")
  );
  check(
    "el terminal es `posted`, no `closed` (el bill asentó, no se pagó)",
    (SERVICE_STATES as readonly string[]).includes("posted") &&
      !(SERVICE_STATES as readonly string[]).includes("closed")
  );
  check(
    "`posted` y `void` cierran; draft/approved/settling siguen abiertos",
    !isOpen("posted") &&
      !isOpen("void") &&
      isOpen("draft") &&
      isOpen("approved") &&
      isOpen("settling")
  );
}

// ─── §2 · Cuentas DISJUNTAS ──────────────────────────────────────────────────
// La premisa de todo el diseño: comisiones y servicios comparten
// `bill_type='service'` y se separan por CUENTA. Si los conjuntos se tocan, un
// mismo bill podría ser válido para las dos features y pagarse dos veces.
console.log("\n§2 · Las cuentas de comisión y de subcontrato son DISJUNTAS");
{
  const COMMISSION_ACCOUNTS = [
    { full_name: "Commission for Sale:Referral", account_type: "CostOfGoodsSold" },
    {
      full_name: "Commission for Purchase:Veetech Representative",
      account_type: "Expense",
    },
  ];
  const SERVICE_ACCOUNTS = [
    { full_name: "Subcontractor Labor", account_type: "CostOfGoodsSold" },
    {
      full_name: "Subcontractor Labor:Electrical/Construction Service",
      account_type: "CostOfGoodsSold",
    },
    { full_name: "Subcontractor Labor:Bella Lighting", account_type: "CostOfGoodsSold" },
  ];

  for (const a of SERVICE_ACCOUNTS) {
    check(
      `"${a.full_name}" es aceptada por un bill de servicio`,
      accountAllowedForVendorBillType("service", a)
    );
  }
  for (const a of COMMISSION_ACCOUNTS) {
    check(
      `"${a.full_name}" sigue aceptada (no se rompió comisiones)`,
      accountAllowedForVendorBillType("service", a)
    );
  }

  // La disjunción real: una cuenta de subcontrato NO puede pasar por el filtro
  // de comisiones y viceversa. Como el allowlist es compartido, la separación
  // la impone `validateVendorBillForService` / `validateVendorBillForSettlement`
  // exigiendo la cuenta EXACTA — acá se afirma que los NOMBRES no se solapan.
  const overlap = SERVICE_ACCOUNTS.filter((s) =>
    COMMISSION_ACCOUNTS.some(
      (c) => c.full_name.toLowerCase() === s.full_name.toLowerCase()
    )
  );
  check(
    "ningún nombre de cuenta pertenece a las dos features",
    overlap.length === 0,
    overlap.map((o) => o.full_name).join(", ")
  );

  check(
    "una cuenta de INGRESO nunca es aceptada (Services:Programming Services es lo que VENDEMOS)",
    !accountAllowedForVendorBillType("service", {
      full_name: "Services:Programming Services",
      account_type: "Income",
    })
  );
  check(
    "una cuenta que sólo se LLAMA parecido pero no es COGS se rechaza",
    !accountAllowedForVendorBillType("service", {
      full_name: "Subcontractor Labor Reimbursements",
      account_type: "Expense",
    })
  );
}

// ─── §3 · Las rutas que mutan exigen PIN y accounting ────────────────────────
console.log("\n§3 · Toda ruta que muta exige accounting + PIN de supervisor");
{
  const MUST_GATE_ROUTES = [
    "src/api/admin/outsourced-services/types/route.ts",
    "src/api/admin/outsourced-services/orders/[orderId]/route.ts",
    "src/api/admin/outsourced-services/orders/[orderId]/services/[serviceId]/route.ts",
  ];

  for (const rel of MUST_GATE_ROUTES) {
    let src: string;
    try {
      src = read(rel);
    } catch {
      check(`${rel} existe`, false, "archivo ausente");
      continue;
    }
    const handlers = handlerBodies(src);
    const mutating = MUTATING_METHODS.filter((h) => handlers.has(h));

    // Sin esto, un regex que dejara de matchear pasaría EN VACÍO: cero
    // handlers encontrados son cero checks fallidos.
    check(
      `${rel} expone al menos un handler que muta`,
      mutating.length > 0,
      `handlers vistos: ${[...handlers.keys()].join(",") || "ninguno"}`
    );

    for (const name of mutating) {
      const body = handlers.get(name) as string;
      check(
        `${rel} · ${name} llama assertAccounting`,
        /assertAccounting\s*\(/.test(body)
      );
      check(
        `${rel} · ${name} llama requireSupervisorPin`,
        /requireSupervisorPin\s*\(/.test(body)
      );
    }
  }

  // El GET del listado NO debe pedir PIN (leer no autoriza nada) pero SÍ accounting.
  const listHandlers = handlerBodies(
    read("src/api/admin/outsourced-services/route.ts")
  );
  const listGet = listHandlers.get("GET") ?? "";
  check("el listado expone un GET", listGet.length > 0);
  check("el listado exige accounting", /assertAccounting\s*\(/.test(listGet));
  check(
    "el listado NO exige PIN (aserción negativa: leer no es autorizar)",
    !/requireSupervisorPin\s*\(/.test(listGet)
  );

  // El GET del catálogo también es lectura: accounting sí, PIN no.
  const typesGet = handlerBodies(
    read("src/api/admin/outsourced-services/types/route.ts")
  ).get("GET");
  check("el GET del catálogo existe", !!typesGet);
  check(
    "el GET del catálogo exige accounting (el de comisiones quedó sin guard)",
    /assertAccounting\s*\(/.test(typesGet ?? "")
  );
}

// ─── §4 · Ningún step propio en el pipeline de QuickBooks ────────────────────
// Aserción NEGATIVA: el bill viaja por el chokepoint normal de vendor bills.
// Si alguien agrega un step propio, este check lo obliga a justificarlo.
console.log("\n§4 · Servicios NO agrega steps al pipeline de QuickBooks");
{
  const libFiles = [
    "src/lib/outsourced-services/settle.ts",
    "src/lib/outsourced-services/writer.ts",
    "src/lib/outsourced-services/config.ts",
  ];
  for (const rel of libFiles) {
    const src = read(rel);
    check(
      `${rel} no escribe filas de pipeline`,
      !/writePipelineRow|qb_order_pipeline|bridgeFetch/.test(src)
    );
  }
  const types = read("src/lib/quickbooks/pipeline/types.ts");
  check(
    "PipelineStep no declara ningún step `outsourced_service*`",
    !/outsourced_service/.test(types)
  );
}

// ─── §5 · Invariantes de datos (requiere DATABASE_URL) ───────────────────────
async function dbChecks(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log(
      "\n§5 · SALTEADO — sin DATABASE_URL no corren los chequeos de datos.\n" +
        "     Correr con DATABASE_URL apuntando al sandbox para cubrirlos."
    );
    failures.push(
      "§5 no corrió (sin DATABASE_URL) — la cobertura de datos quedó sin verificar"
    );
    return;
  }

  console.log("\n§5 · Invariantes de datos");
  const pool = new Pool({ connectionString: url });
  try {
    const { rows: idx } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('order_outsourced_service','outsourced_service_settlement','outsourced_service_type')`
    );
    const byName = new Map(idx.map((r) => [r.indexname, r.indexdef]));

    for (const name of [
      "uq_osst_live_per_service",
      "uq_osst_live_per_bill",
      "uq_oos_display_number",
      "uq_ostp_code_live",
    ]) {
      check(`índice ${name} existe`, byName.has(name));
    }

    // failed/reversed DEBEN quedar fuera del predicado: son los que liberan
    // para un reintento legítimo. Si alguien los incluye, un settlement fallido
    // deja el bill preso para siempre.
    for (const name of ["uq_osst_live_per_service", "uq_osst_live_per_bill"]) {
      const def = byName.get(name) ?? "";
      check(
        `${name} deja 'failed' y 'reversed' FUERA del predicado`,
        def.includes("pending") &&
          def.includes("qb_waiting") &&
          def.includes("confirmed") &&
          !def.includes("failed") &&
          !def.includes("reversed"),
        def || "índice ausente"
      );
    }

    const { rows: counter } = await pool.query<{ value: string }>(
      `SELECT value FROM document_number_counter WHERE name = 'order_outsourced_service'`
    );
    check("el contador OSV existe", counter.length === 1);

    // Un servicio aprobado o más allá SIEMPRE tiene número y cuenta congelados.
    // El CHECK de la base ya lo impone; esto lo cruza con datos reales por si
    // alguien lo dropea en una migración futura.
    const { rows: unfrozen } = await pool.query<{ id: string; state: string }>(
      `SELECT id, state FROM order_outsourced_service
        WHERE deleted_at IS NULL
          AND state NOT IN ('draft','void')
          AND (display_number IS NULL OR qb_account_list_id IS NULL)`
    );
    check(
      "ningún servicio aprobado quedó sin número o sin cuenta congelada",
      unfrozen.length === 0,
      unfrozen.map((r) => `${r.id}:${r.state}`).join(", ")
    );

    // El modo de falla que ninguna de las dos features ve sola.
    const { rows: doubleClaim } = await pool.query<{ vendor_bill_id: string }>(
      `SELECT s.vendor_bill_id
         FROM outsourced_service_settlement s
        WHERE s.status IN ('pending','qb_waiting','confirmed')
          AND s.vendor_bill_id IS NOT NULL
          AND EXISTS (
                SELECT 1 FROM commission_settlement c
                 WHERE c.vendor_bill_id = s.vendor_bill_id
                   AND c.status IN ('pending','qb_waiting','confirmed'))`
    );
    check(
      "ningún vendor bill está reclamado a la vez por un servicio y una comisión",
      doubleClaim.length === 0,
      doubleClaim.map((r) => r.vendor_bill_id).join(", ")
    );

    // Un settlement vivo cuyo servicio NO está en settling/posted es deriva.
    const { rows: orphan } = await pool.query<{ id: string; state: string }>(
      `SELECT s.id, o.state
         FROM outsourced_service_settlement s
         JOIN order_outsourced_service o ON o.id = s.service_id
        WHERE s.status IN ('pending','qb_waiting')
          AND o.state NOT IN ('settling','posted')`
    );
    check(
      "todo settlement vivo cuelga de un servicio en settling o posted",
      orphan.length === 0,
      orphan.map((r) => `${r.id}:${r.state}`).join(", ")
    );

    const { rows: badType } = await pool.query<{ id: string }>(
      `SELECT id FROM outsourced_service_type
        WHERE deleted_at IS NULL
          AND ((qb_account_list_id IS NULL) <> (qb_account_full_name IS NULL))`
    );
    check(
      "ningún tipo tiene media cuenta configurada",
      badType.length === 0,
      badType.map((r) => r.id).join(", ")
    );
  } finally {
    await pool.end();
  }
}

void (async () => {
  await dbChecks();

  console.log(
    `\n${"═".repeat(64)}\n` +
      `verify-outsourced-services: ${passed} OK, ${failures.length} FALLARON`
  );
  if (failures.length) {
    console.log("\nFallas:");
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log("Todo verde.\n");
})();
