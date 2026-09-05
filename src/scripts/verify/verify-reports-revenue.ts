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

  // ── FLETE (2026-09-04) ────────────────────────────────────────────────────
  //
  // El flete es INGRESO en QuickBooks: el item `SHIPPING & HANDLING` apunta a
  // `Sales:Shipping and Delivery Income`. Los reportes no lo contaban y por eso
  // quedaban $310,00 por debajo de QB en agosto 2026. Los tres checks que
  // siguen protegen las DOS reglas que hacen que agregarlo no rompa nada.

  // 3b. El flete NO puede entrar en la expresión por LÍNEA.
  //     `commission-expr.ts` usa `NET_ITEM_REVENUE` como PESO para prorratear
  //     comisiones entre las facturas de una orden. Meterle el flete redistribuye
  //     centavos de comisiones YA LIQUIDADAS a gente real — plata de otro.
  const commissionExpr = readFileSync(resolve(REPORTS, "_lib/commission-expr.ts"), "utf8");
  check(
    "el flete NO entra en NET_ITEM_REVENUE ni en el peso de comisiones",
    !/shipping/i.test(NET_ITEM_REVENUE) && !/\bi\.shipping\b/.test(commissionExpr)
  );

  // 3c. Ninguna RUTA suma el flete a mano.
  //     Toda ruta hace `JOIN pos_invoice_item`; un `SUM(i.shipping)` ahí
  //     multiplica el flete por la cantidad de líneas de la factura. El único
  //     lugar donde `i.shipping` puede aparecer es `_lib/shipping-revenue.ts`,
  //     que reduce por factura ANTES de cualquier join.
  //     Se descuentan las líneas de `import` antes de buscar: un check que mira
  //     el archivo entero se conforma con que el símbolo esté importado, que es
  //     el defecto que ya costó una ruta sin gate en `verify-pin-enforcement`.
  const handRolled = files
    .filter((f) => f.endsWith("route.ts"))
    .filter((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !/^\s*import\b/.test(l))
        .some((l) => /\bi\.shipping\b/.test(l))
    )
    .map((f) => f.replace(`${REPORTS}/`, ""));
  check(
    "ninguna ruta suma i.shipping a mano (fan-out por cantidad de líneas)",
    handRolled.length === 0,
    handRolled.length ? handRolled.join(", ") : "0 rutas"
  );

  // 3d. El ciclo de imports, otra vez — ahora con el módulo nuevo.
  //     `shipping-revenue` importa DE `sales-revenue`; el inverso cierra el
  //     ciclo y Medusa muere al registrar rutas. type-check y build pasan los
  //     dos con el ciclo puesto: sólo lo caza arrancar el servidor.
  const salesRev = readFileSync(resolve(REPORTS, "_lib/sales-revenue.ts"), "utf8");
  check(
    "sales-revenue no importa shipping-revenue (ciclo que rompe el boot)",
    !/from\s+["']\.\/shipping-revenue["']/.test(salesRev)
  );

  // ── UNIDADES (2026-09-04) ─────────────────────────────────────────────────
  //
  // Las unidades y el dinero neteaban la misma devolución con DOS modelos de
  // atribución distintos. `pos_invoice_item.refunded_quantity` es acumulativa de
  // por vida (el modelo lo dice: "cumulative units refunded via credit memos"),
  // así que restaba en el período de la VENTA; el dinero se resta con un CTE
  // scopeado al período de la DEVOLUCIÓN. Consecuencias medidas: un mes cerrado
  // perdía unidades solo con que pasara el tiempo (julio 2026: −116), y el
  // precio y el costo por unidad del tab By Item quedaban mal en todo SKU con
  // devolución cruzada de mes.
  //
  // Las rutas se afirman por NOMBRE, no por lo que su texto mencione: una ruta
  // que deba netear y no nombre nada nunca entraría en un barrido por patrón y
  // saldría limpia — es el defecto que ya costó una ruta sin gate en
  // `verify-pin-enforcement`.
  const MUST_NET_QTY_BY_CM = [
    "sales/by-item/route.ts",
    "sales/by-category/route.ts",
    "sales/profit-summary/route.ts",
  ];

  // Las líneas de comentario se descuentan antes de buscar: los tres archivos
  // EXPLICAN por qué ya no usan `refunded_quantity`, y un check que mira el
  // texto crudo se dispararía con su propia documentación.
  const sqlOf = (file: string): string =>
    readFileSync(resolve(REPORTS, file), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|--|\*|\/\*)/.test(l.trim()) && !/^\s*import\b/.test(l))
      .join("\n");

  for (const file of MUST_NET_QTY_BY_CM) {
    let sql: string;
    try {
      sql = sqlOf(file);
    } catch {
      check(`${file} existe y es auditable`, false, "no se pudo leer — ¿renombrada?");
      continue;
    }
    check(
      `${file}: NO netea unidades con refunded_quantity`,
      !/\brefunded_quantity\b/.test(sql),
      /\brefunded_quantity\b/.test(sql) ? "sigue usándola en SQL" : ""
    );
    check(
      `${file}: su CTE de credit memos expone SUM(cmi.quantity) AS cm_qty`,
      /SUM\(\s*cmi\.quantity\s*\)\s*::int\s+AS\s+cm_qty/.test(sql)
    );
    check(
      `${file}: resta cm_qty de las unidades`,
      /-\s*COALESCE\(\s*[a-z]\.cm_qty\s*,\s*0\s*\)/.test(sql)
    );
  }
  // Sin esto, borrar la lista dejaría el bloque entero pasando en vacío.
  check(
    "la lista de rutas que netean unidades no está vacía",
    MUST_NET_QTY_BY_CM.length === 3,
    `${MUST_NET_QTY_BY_CM.length} rutas`
  );

  // ── FAN-OUT DEL JOIN (2026-09-04) ─────────────────────────────────────────
  //
  // La clave con la que se AGRUPA tiene que ser la clave con la que se JOINEA.
  // `by-item` agrupaba por (variant_id, sku) y emparejaba por variant_id: una
  // variante vendida bajo dos escrituras de SKU producía dos filas y la fila de
  // credit memo se pegaba a las DOS. Medido en prod: 6 variantes, +96 unidades
  // informadas de más y $122,29 de devoluciones restadas dos veces — o sea que
  // abanicaba el DINERO (revenue y gross profit), no sólo las unidades. Vivió
  // invisible porque una suma absorbe lo que una división por unidad delata.
  // `profit-summary` tenía la forma gemela con (sku, description): 16 SKUs.
  //
  // El check es ESTRECHO —la línea del GROUP BY, anclada a fin de línea— porque
  // "aparecen las dos columnas cerca" marcaría rutas sanas, y un check ruidoso
  // se termina ignorando.
  const groupJoinKeys: [string, RegExp[]][] = [
    ["sales/by-item/route.ts", [/GROUP BY pii\.variant_id\s*$/m, /GROUP BY cmi\.variant_id\s*$/m]],
    ["sales/profit-summary/route.ts", [/GROUP BY pii\.sku\s*$/m, /GROUP BY cmi\.sku\s*$/m]],
  ];
  for (const [file, pats] of groupJoinKeys) {
    const src = readFileSync(resolve(REPORTS, file), "utf8");
    check(
      `${file}: agrupa por la MISMA clave con la que joinea (sin fan-out)`,
      pats.every((re) => re.test(src)),
      pats.every((re) => re.test(src))
        ? ""
        : "un GROUP BY tiene columnas de más — la fila de credit memo se pega a varias filas de venta"
    );
  }


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

    // 4b. La PREMISA del neteo de unidades por credit memo: toda unidad marcada
    //     como devuelta en una factura tiene una línea de credit memo que la
    //     respalda. Medido al shipear: 170 líneas / 1.397 unidades, 0 sin
    //     respaldo. Si algún día aparece un camino que suba `refunded_quantity`
    //     sin crear un `pos_credit_memo_item`, esas unidades dejarían de
    //     restarse y las tres rutas sobreinformarían ventas EN SILENCIO. Este
    //     check es lo único que puede avisarlo: los estáticos miran la forma del
    //     SQL, no de dónde salen los datos.
    const orph = await db.query(
      `WITH inv AS (
         SELECT pii.invoice_id, pii.variant_id, SUM(pii.refunded_quantity)::int AS q
         FROM pos_invoice_item pii
         JOIN pos_invoice i ON i.id = pii.invoice_id AND ${ACTIVE}
         WHERE pii.deleted_at IS NULL AND pii.refunded_quantity > 0
           AND pii.variant_id IS NOT NULL
         GROUP BY 1, 2
       ), cm AS (
         SELECT c.invoice_id, cmi.variant_id
         FROM pos_credit_memo c
         JOIN pos_credit_memo_item cmi
           ON cmi.credit_memo_id = c.id AND cmi.deleted_at IS NULL
         WHERE c.deleted_at IS NULL AND c.status = 'completed'
         GROUP BY 1, 2
       )
       SELECT COUNT(*)::int AS n, COALESCE(SUM(inv.q), 0)::int AS unidades
       FROM inv
       LEFT JOIN cm ON cm.invoice_id = inv.invoice_id AND cm.variant_id = inv.variant_id
       WHERE cm.invoice_id IS NULL`
    );
    const orphN = Number(orph.rows[0].n);
    check(
      "toda unidad refundeada tiene su línea de credit memo (premisa del neteo por CM)",
      orphN === 0,
      orphN === 0 ? "0 huérfanas" : `${orphN} línea(s) / ${orph.rows[0].unidades} unidad(es) sin credit memo`
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

    // 7b. Los DOS supuestos sobre los que descansan todos los LEFT JOIN del
    //     flete. Si alguno se rompe, la plata desaparece en silencio: una
    //     factura con flete y sin cliente se cae de `by-customer`, y una sin
    //     líneas se cae de `trend` y del `heatmap` (esas agregan sobre el join
    //     a `pos_invoice_item`). Medidos en cero el 2026-09-04.
    const supuestos = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE i.customer_id IS NULL)::int AS sin_cliente,
         COUNT(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM pos_invoice_item x
           WHERE x.invoice_id = i.id AND x.deleted_at IS NULL))::int AS sin_lineas
       FROM pos_invoice i
       WHERE ${ACTIVE} AND COALESCE(i.shipping, 0) <> 0`
    );
    const { sin_cliente, sin_lineas } = supuestos.rows[0];
    check(
      "toda factura con flete tiene cliente Y tiene líneas (o el flete se pierde)",
      Number(sin_cliente) === 0 && Number(sin_lineas) === 0,
      `${sin_cliente} sin cliente · ${sin_lineas} sin líneas`
    );

    // 7c. `refunded_shipping` es el espejo invoice-level de `refunded_quantity`
    //     y se ignora A PROPÓSITO: las devoluciones acá son CM-autoritativas, y
    //     restar las dos cosas contaría la misma devolución dos veces. La
    //     decisión se tomó con la columna en CERO en toda la historia. El día
    //     que deje de estarlo hay que volver a decidir, no seguir ignorándola.
    const refShip = await db.query(
      `SELECT COUNT(*)::int AS n FROM pos_invoice
       WHERE deleted_at IS NULL AND COALESCE(refunded_shipping, 0) <> 0`
    );
    const refShipN = Number(refShip.rows[0].n);
    check(
      "refunded_shipping sigue en cero (la simetría del flete se decidió así)",
      refShipN === 0,
      `${refShipN} factura(s) — si esto se pone rojo, releer _lib/shipping-revenue.ts`
    );

    // 7d. LA invariante del flete: el bruto que publican los reportes tiene que
    //     ser `Σ(subtotal + shipping)`, que es exactamente el `Subtotal` que
    //     devuelve `InvoiceRet` de QuickBooks (ya incluye la línea de flete y
    //     excluye el impuesto). Es la afirmación entera de la paridad, en SQL.
    const bruto = await db.query(
      `WITH lineas AS (
         SELECT ROUND(SUM(${NET_ITEM_REVENUE}))::bigint AS c
         FROM pos_invoice_item pii
         JOIN pos_invoice i ON i.id = pii.invoice_id AND ${ACTIVE}
         WHERE pii.deleted_at IS NULL
       ), docs AS (
         SELECT SUM(i.subtotal)::bigint AS sub,
                SUM(COALESCE(i.shipping, 0))::bigint AS ship
         FROM pos_invoice i WHERE ${ACTIVE}
       )
       SELECT l.c AS lineas, d.sub, d.ship,
              (l.c + d.ship) = (d.sub + d.ship) AS cuadra
       FROM lineas l, docs d`
    );
    const b = bruto.rows[0];
    check(
      "ingreso por línea + flete = Σ(subtotal + shipping) — el Subtotal de QB",
      b.cuadra === true,
      `líneas ${b.lineas} + flete ${b.ship} vs subtotal ${b.sub} + flete ${b.ship}`
    );

    // 7e. Control negativo del flete: sin el término, el total NO llega al de
    //     QuickBooks. Sin esto, 7d podría estar pasando porque el flete es cero
    //     —que es como estuvo hasta abril 2026— en vez de porque se sumó.
    const ctrl = await db.query(
      `SELECT SUM(COALESCE(i.shipping, 0))::bigint AS ship
       FROM pos_invoice i WHERE ${ACTIVE}`
    );
    const shipTotal = Number(ctrl.rows[0].ship);
    check(
      "control negativo: hay flete que contar (si no, 7d es vacuo)",
      shipTotal > 0,
      `$${(shipTotal / 100).toFixed(2)} de flete histórico`
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
