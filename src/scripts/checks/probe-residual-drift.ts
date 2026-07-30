/**
 * probe-residual-drift.ts
 *
 * Demuestra, contra una orden REAL, que las cuatro formas de expresar el mismo
 * descuento llegan al mismo total — y falla si alguna vuelve a separarse.
 *
 * ── Qué problema documenta ──────────────────────────────────────────────────
 * El total se deriva de una base leída de las líneas de la orden, y el caller
 * ADEMÁS le pasa una figura de descuento a esa derivación. Sólo se resta la parte
 * que la base no carga ya (el "residual"). Ese residual no puede distinguir
 * "el caller anuncia un centavo más de descuento" de "el caller expresó el MISMO
 * descuento con otro redondeo": son aritméticamente idénticos y contablemente
 * opuestos.
 *
 * Sobre S11242 la base per-línea da 138.07 y cualquier agregado del mismo
 * descuento da 138.08, así que el residual salía 1¢ y el total caía a 1699.06 —
 * un centavo por debajo de lo que QuickBooks facturó en la Invoice 19614 y por
 * debajo del papel que tiene el cliente. `resolveDiscountResidual` separa las dos
 * cosas; este probe es la prueba de que sigue separándolas.
 *
 * ── Cómo se lee la salida ───────────────────────────────────────────────────
 * Una fila por fuente de descuento. Todas tienen que decir OK y el mismo TOTAL.
 * Un DRIFT significa que una fuente volvió a imponer su convención.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *   ./node_modules/.bin/tsx src/scripts/checks/probe-residual-drift.ts
 *   DOC=S11242 ./node_modules/.bin/tsx src/scripts/checks/probe-residual-drift.ts
 *   PROBE_DATABASE_URL=<url> ./node_modules/.bin/tsx src/scripts/checks/probe-residual-drift.ts
 *
 * Read-only: sólo SELECT. Por defecto pega a la sandbox, no a producción.
 */
import { Pool } from "pg";

import {
  loadOrderMoneyBase,
  resolvePatchedOrderTotal,
  resolveQbParityTax,
} from "../../lib/order-money/order-tax-lines";

const SANDBOX_URL = "postgresql://postgres:sandbox@localhost:5499/medusa";

/** Documento y su verdad de QuickBooks, leída del bridge el 2026-07-30. */
const DOC = process.env.DOC ?? "S11242";
const QB = {
  S11242: { doc: "Invoice 19614", total: 1699.07, rate: 7 },
} as const;

type Fuente = { etiqueta: string; discount: number };

async function main(): Promise<void> {
  const expected = QB[DOC as keyof typeof QB];
  if (!expected) {
    throw new Error(
      `sin verdad de QuickBooks congelada para ${DOC} — agregala a QB o usá uno de: ${Object.keys(QB).join(", ")}`
    );
  }

  const connectionString = process.env.PROBE_DATABASE_URL ?? SANDBOX_URL;
  // Railway exige SSL y el Postgres local lo rechaza de plano.
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  });

  let drifted = 0;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM "order" WHERE metadata->>'document_number' = $1 LIMIT 1`,
      [DOC]
    );
    const orderId = rows[0]?.id;
    if (!orderId) throw new Error(`${DOC} no existe en esta base`);

    const base = await loadOrderMoneyBase(pool, orderId);
    console.log(`\n${DOC} · QuickBooks ${expected.doc} facturó TOTAL ${expected.total}`);
    console.log("=".repeat(84));
    console.log("base leída de las líneas reales:");
    console.log(`  neto ${base.netDollars} · imponible ${base.taxableNetDollars} · envío ${base.shippingDollars}`);
    console.log(`  adjustments ${base.adjustmentsDollars} (per-línea, sobre ${base.discountedLineCount} líneas) · horneado ${base.bakedDiscountDollars}\n`);

    // Las cuatro formas en que este mismo descuento llega a la derivación.
    const fuentes: Fuente[] = [
      { etiqueta: "no anunciado (el summary está NULL)", discount: 0 },
      { etiqueta: "per-línea (lo que factura QB)", discount: base.adjustmentsDollars },
      // Las dos de abajo son EL MISMO descuento en la otra convención: sumar sin
      // redondear y redondear al final da un centavo más que sumar redondeando
      // cada línea. No son descuentos distintos — por eso tienen que dar igual.
      { etiqueta: "agregado, redondeado una vez", discount: base.adjustmentsDollars + 0.01 },
      { etiqueta: "crudo de Medusa (sin redondear)", discount: base.adjustmentsDollars + 0.0092 },
    ];

    for (const { etiqueta, discount } of fuentes) {
      const parity = resolveQbParityTax(base, discount, expected.rate);
      const r = resolvePatchedOrderTotal({
        base,
        posTaxAmount: parity.tax,
        discount,
      });
      const ok = r.ok && Math.abs(r.total - expected.total) < 0.005;
      if (!ok) drifted += 1;
      const total = r.ok ? r.total.toFixed(2) : `RECHAZADO: ${r.reason}`;
      console.log(
        `${ok ? "OK   " : "DRIFT"} ${etiqueta.padEnd(38)} desc=${discount.toFixed(4).padStart(9)} ` +
          `imponible=${parity.taxableBase.toFixed(2)} tax=${parity.tax.toFixed(2)} TOTAL=${total}`
      );
    }
  } finally {
    await pool.end();
  }

  console.log("=".repeat(84));
  if (drifted > 0) {
    console.error(
      `\n❌ ${drifted} fuente(s) NO llegan a ${expected.total}: una convención volvió a imponerse sobre la derivación.\n`
    );
    process.exit(1);
  }
  console.log(
    `\n✅ las 4 fuentes del mismo descuento llegan a ${expected.total}, el total que QuickBooks facturó.\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
