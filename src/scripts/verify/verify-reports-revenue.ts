/**
 * verify-reports-revenue.ts — gate del ingreso canónico de los reportes.
 *
 * Correr:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-reports-revenue.ts
 *
 * Es un script tsx PLANO a propósito, no un `medusa exec`. Los verify con
 * `export default` corridos con tsx no ejecutan nada y salen 0 — un verificador
 * que puede quedarse mudo y aprobado no sirve — y `medusa exec` sin
 * DISABLE_SCHEDULED_JOBS levanta todos los crons contra la base a la que apunte.
 *
 * Importa las constantes REALES de `_lib`, nunca una copia: un gate que
 * reimplementa la fórmula que vigila deja de vigilar el día que la fórmula
 * cambie.
 *
 * ── Qué protege ──────────────────────────────────────────────────────────────
 *
 * Los reportes contaban el mismo dinero de dos formas y ninguna advertencia lo
 * decía. `customers/top-performers` informaba STIGMA WOOD CORP. en $24,556.00 y
 * `sales/by-customer` en $17,680.32, para el mismo cliente y el mismo período.
 * Dos causas:
 *
 *  1. Los 8 `customers/` usaban `SUM(pii.total)` — el total BRUTO de la línea,
 *     sin descuentos y sin revertir devoluciones ($43,906.34 · 9.18%).
 *  2. `NET_ITEM_REVENUE` repartía `i.discount` (que agrega ítem + orden) por
 *     peso BRUTO, así que el descuento de UNA línea se esparcía sobre TODAS
 *     ($2,324.02 mal atribuidos en 66 facturas).
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { resolve } from "path";

import { Client } from "pg";

import { NET_ITEM_REVENUE } from "../../api/admin/reports/_lib/revenue-expr";

const ROOT = resolve(__dirname, "../../..");
const REPORTS = resolve(ROOT, "src/api/admin/reports");

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = resolve(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌ Falta DATABASE_URL. Sin destino explícito este gate no corre.");
    process.exit(1);
  }
  const shortUrl = url.replace(/\/\/[^@]*@/, "//***@");
  console.log(`\n🔎 verify-reports-revenue — ${shortUrl}\n`);

  // ── ESTÁTICOS ─────────────────────────────────────────────────────────────
  console.log("Estáticos (regresión de forma):");
  const files = walk(REPORTS);

  // 1. Ninguna ruta vuelve a usar el bruto como ingreso.
  //
  //    El patrón se busca por `pii.total` a secas y NO por `SUM(pii.total)`:
  //    `customers/activity-segments` lo usaba dentro de un CASE
  //    (`SUM(CASE WHEN … THEN pii.total ELSE 0 END)`) y por eso sobrevivió a la
  //    auditoría por grep — reportaba $521,757.94 donde el neto era $479,575.85.
  //    Un check cuya cobertura depende de la FORMA exacta del texto no cubre.
  //
  //    `net_total_cents, pii.total` es el fallback legacy del COALESCE y es
  //    legítimo: se descuenta antes de buscar.
  const rawUsers = files
    .filter((f) => f.endsWith("route.ts"))
    .filter((f) => {
      const src = readFileSync(f, "utf8").split("net_total_cents, pii.total").join("");
      return /\bpii\.total\b/.test(src);
    })
    .map((f) => f.replace(`${REPORTS}/`, ""));
  check(
    "ninguna ruta usa pii.total como ingreso (en NINGUNA forma, ni dentro de un CASE)",
    rawUsers.length === 0,
    rawUsers.length ? rawUsers.join(", ") : "0 rutas"
  );

  // 1b. Nadie vuelve a restar CENTAVOS menos DÓLARES.
  //     `NET_ITEM_REVENUE` está en centavos y `COST_DOLLARS` en dólares. El
  //     ORDER BY de `sales/profit-summary` los restaba directo, y como el costo
  //     en dólares es ~100× más chico, la resta era casi el revenue: el "Top
  //     profitable" venía ordenando por FACTURACIÓN. Medido: dos SKUs entraban
  //     al top 5 por profit real y el orden viejo no los mostraba.
  //     El patrón se busca ESTRECHO —los dos dentro de una misma resta— y no
  //     "los dos aparecen cerca": tenerlos como columnas separadas en el mismo
  //     SELECT es lo normal y correcto (el JS divide el revenue después). Una
  //     primera versión amplia marcó 9 rutas sanas, y un check ruidoso se
  //     termina ignorando, que es peor que no tenerlo.
  const unitMix = files
    .filter((f) => f.endsWith("route.ts"))
    .filter((f) =>
      /\$\{NET_ITEM_REVENUE\}\s*\)\s*-\s*SUM\(\s*\$\{COST_DOLLARS\}/.test(
        readFileSync(f, "utf8")
      )
    )
    .map((f) => f.replace(`${REPORTS}/`, ""));
  check(
    "ningún reporte resta CENTAVOS menos DÓLARES (revenue vs COST_DOLLARS)",
    unitMix.length === 0,
    unitMix.length ? unitMix.join(", ") : "0 rutas"
  );

  // 2. El ciclo de imports que tumbó el boot no puede volver.
  //    revenue-expr NO importa sales-revenue: sales-revenue ya importa
  //    revenue-expr, así que el inverso cierra el ciclo y Medusa muere al
  //    registrar rutas con "Cannot access CM_REFUND_CENTS_EXPR before
  //    initialization". type-check y build pasan LOS DOS con el ciclo puesto:
  //    sólo lo caza arrancar el servidor, y para entonces ya está en Railway.
  const revExpr = readFileSync(resolve(REPORTS, "_lib/revenue-expr.ts"), "utf8");
  check(
    "revenue-expr no importa sales-revenue (ciclo que rompe el boot)",
    !/from\s+["']\.\/sales-revenue["']/.test(revExpr)
  );

  // 3. La expresión canónica parte del NETO, no del bruto.
  check(
    "NET_ITEM_REVENUE usa net_total_cents, no pii.total crudo",
    NET_ITEM_REVENUE.includes("net_total_cents") &&
      !/\bpii\.total::numeric\s*\*/.test(NET_ITEM_REVENUE)
  );

  // ── DATOS ─────────────────────────────────────────────────────────────────
  console.log("\nDatos (invariantes contra la base):");
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const ACTIVE = `i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')`;

    // 4. LA invariante: Σ del ingreso por línea === el subtotal del documento,
    //    factura por factura. Si esto se cumple, ningún reporte puede publicar
    //    un total que el documento no diga.
    const inv = await db.query(
      `SELECT COUNT(*)::int AS malas FROM (
         SELECT i.id, SUM(${NET_ITEM_REVENUE}) AS suma, MIN(i.subtotal) AS sub
         FROM pos_invoice_item pii
         JOIN pos_invoice i ON i.id = pii.invoice_id AND ${ACTIVE}
         WHERE pii.deleted_at IS NULL
         GROUP BY i.id
         HAVING ROUND(SUM(${NET_ITEM_REVENUE})) <> MIN(i.subtotal)
       ) q`
    );
    const malas = Number(inv.rows[0].malas);
    check(
      "Σ ingreso por línea = i.subtotal en TODA factura activa",
      malas === 0,
      `${malas} factura(s) fuera de cuadre`
    );

    // 5. El fallback legacy no puede estar tapando un descuento de ítem: una
    //    línea sin `net_total_cents` cae en `pii.total`, que es BRUTO.
    const leg = await db.query(
      `SELECT COUNT(*)::int AS n FROM pos_invoice_item
       WHERE deleted_at IS NULL AND net_total_cents IS NULL
         AND discount_value IS NOT NULL AND discount_value > 0`
    );
    const legN = Number(leg.rows[0].n);
    check(
      "ninguna línea legacy (sin net_total_cents) tiene descuento de ítem",
      legN === 0,
      `${legN} línea(s)`
    );

    // 6. El síntoma que el operador VE: las dos familias de reportes tienen que
    //    dar el mismo ingreso para el mismo cliente. Se compara la aritmética
    //    de ambas, no sus endpoints, para que el gate corra sin servidor.
    const fam = await db.query(
      `WITH ventas AS (
         SELECT i.customer_id, SUM(${NET_ITEM_REVENUE}) AS bruto
         FROM pos_invoice_item pii
         JOIN pos_invoice i ON i.id = pii.invoice_id AND ${ACTIVE}
         WHERE pii.deleted_at IS NULL AND i.customer_id IS NOT NULL
         GROUP BY i.customer_id
       ), devol AS (
         SELECT cm.customer_id,
                SUM(COALESCE(cm.subtotal,
                    GREATEST(cm.total - COALESCE(cm.tax,0) - COALESCE(cm.shipping,0), 0))) AS ref
         FROM pos_credit_memo cm
         WHERE cm.deleted_at IS NULL AND cm.status = 'completed'
           AND cm.customer_id IS NOT NULL
         GROUP BY cm.customer_id
       )
       SELECT COUNT(*)::int AS n,
              COALESCE(ROUND(SUM(v.bruto - COALESCE(d.ref,0))),0)::bigint AS neto
       FROM ventas v LEFT JOIN devol d ON d.customer_id = v.customer_id`
    );
    const { n, neto } = fam.rows[0];
    check(
      "el ingreso por cliente es derivable de UNA sola aritmética",
      Number(n) > 0,
      `${n} clientes · $${(Number(neto) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} neto`
    );

    // 7. Una nota de crédito cuyas LÍNEAS no suman su propio subtotal está
    //    corrupta, y contamina la atribución por ítem sin mover ningún total.
    //    CM-1026 tenía sus 7 líneas insertadas dos veces (14 filas, dos tandas a
    //    21 ms) — el encabezado decía 19125 y las líneas 38250, así que by-item y
    //    by-category le atribuían $191.25 de más a productos que nadie devolvió.
    const cmBal = await db.query(
      `SELECT cm.credit_memo_number AS nro,
              cm.subtotal::bigint AS sub,
              SUM(cmi.line_total)::bigint AS lineas
       FROM pos_credit_memo cm
       JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
       WHERE cm.deleted_at IS NULL AND cm.status = 'completed'
       GROUP BY cm.id, cm.credit_memo_number, cm.subtotal
       HAVING cm.subtotal <> SUM(cmi.line_total)`
    );
    check(
      "toda nota de crédito cuadra: Σ line_total = su subtotal",
      cmBal.rows.length === 0,
      cmBal.rows.length
        ? cmBal.rows.map((r: { nro: string; sub: string; lineas: string }) =>
            `${r.nro} (subtotal ${r.sub} vs líneas ${r.lineas})`).join(", ")
        : `${0} descuadrada(s)`
    );

    // 8. Control negativo: la fórmula VIEJA tiene que romper la invariante 4.
    //    Sin esto, el check 4 podría estar pasando por una propiedad trivial
    //    de los datos en vez de por la fórmula.
    const OLD = `CASE WHEN (i.subtotal::numeric + i.discount::numeric) > 0
      THEN pii.total::numeric * i.subtotal::numeric / (i.subtotal::numeric + i.discount::numeric)
      ELSE pii.total::numeric END`;
    const old = await db.query(
      `SELECT COUNT(*)::int AS malas FROM (
         SELECT i.id FROM pos_invoice_item pii
         JOIN pos_invoice i ON i.id = pii.invoice_id AND ${ACTIVE}
         WHERE pii.deleted_at IS NULL
         GROUP BY i.id
         HAVING ROUND(SUM(${OLD})) <> MIN(i.subtotal)
       ) q`
    );
    const oldMalas = Number(old.rows[0].malas);
    check(
      "control negativo: la fórmula vieja SÍ descuadra (si no, el check 4 es vacuo)",
      oldMalas > 0,
      `${oldMalas} factura(s) descuadradas con la fórmula anterior`
    );
  } finally {
    await db.end();
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} chequeo(s) fallaron:`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log("✅ verify-reports-revenue: todo verificado.\n");
}

main().catch((e) => {
  console.error("❌ verify-reports-revenue explotó:", e);
  process.exit(1);
});
