/**
 * E2E — la derivación del total de una orden CON DESCUENTO, contra lo que
 * QuickBooks facturó de verdad.
 *
 * Por qué existe, si ya está `verify-order-total-qb-parity.ts`: ese gate se
 * apoya en dos documentos QB (SR 27807 y Invoice 18861) que NO tienen
 * descuento, así que fija el redondeo del impuesto y la exención por línea y
 * no toca la parte donde el descuento y el impuesto se cruzan — que es
 * exactamente donde `computeTotals` (navegador) y `resolvePatchedOrderTotal`
 * (backend) pueden separarse un centavo sin que nada lo note.
 *
 * Verdad de terreno: leída EN VIVO del bridge el 2026-07-30 con
 * `/api/sync/direct-query` (read-only), `InvoiceQueryRq` / `SalesReceiptQueryRq`
 * por RefNumber. Los números de abajo son los que devolvió QuickBooks, no los
 * que este script calcula — un test que recalcula la fórmula que testea sólo
 * prueba que la fórmula es consistente consigo misma.
 *
 * Forma que tiene un documento con descuento en QB (ej. Invoice 19614):
 *
 *     … líneas de producto a precio BRUTO …
 *     Subtotal   "Order Item Subtotal"     1725.99
 *     Discount   "Order Discount (8%)"     -138.07   SalesTaxCodeRef = Tax
 *     Subtotal (header)                    1587.92   ← ya neto de descuento
 *     SalesTaxTotal @ 7.00%                 111.15   ← 7% sobre 1587.92, UNA vez
 *     TotalAmount                          1699.07
 *
 * O sea: QB PRORRATEA el descuento y lo codifica `Tax`, así que reduce la base
 * imponible; y redondea el impuesto una sola vez sobre el agregado. Las dos
 * cosas ya están en `resolveQbParityTax`. Lo que este script mide es si el
 * resultado FINAL coincide con QB en órdenes reales, y de paso si los tres
 * campos que la UI puede llegar a mostrar dicen todos lo mismo.
 *
 * Read-only: sólo SELECT. No convierte, no edita, no escribe, no toca el bridge.
 *
 * Run (prod, read-only):
 *   cd backend && ./node_modules/.bin/tsx src/scripts/tests/e2e-qb-parity-discounted-orders.ts
 * Run contra el sandbox:
 *   E2E_DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-qb-parity-discounted-orders.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import { Pool } from "pg";

import {
  loadOrderMoneyBase,
  resolvePatchedOrderTotal,
  resolveQbParityTax,
} from "../../lib/order-money/order-tax-lines";

type QbFixture = {
  /** `display_id` de la orden en Medusa. */
  displayId: number;
  /** Documento QB del que salió la verdad de terreno. */
  qbDoc: string;
  /** Suma de las líneas de producto a precio bruto (línea "Subtotal" de QB). */
  qbGrossSubtotal: number;
  /** La línea Discount de QB, en positivo. */
  qbDiscount: number;
  /** Header `Subtotal` de QB = bruto − descuento. */
  qbNetSubtotal: number;
  /** `SalesTaxPercentage`. */
  qbRate: number;
  /** `SalesTaxTotal`. */
  qbTax: number;
  /** `TotalAmount` (o `-AppliedAmount` cuando el Ret de invoice no lo trae). */
  qbTotal: number;
  note: string;
};

/**
 * Ocho documentos, elegidos porque son TODOS los que en producción tienen
 * descuento de orden y un documento QB confirmado. Cubren: porcentaje del 8,
 * 10, 12.5 y 13; con impuesto y exentos; invoice y sales receipt.
 */
const FIXTURES: QbFixture[] = [
  {
    displayId: 2811,
    qbDoc: "Invoice 19614 (TxnID 1CB34C-1785165203, 2026-07-27)",
    qbGrossSubtotal: 1725.99,
    qbDiscount: 138.07,
    qbNetSubtotal: 1587.92,
    qbRate: 7,
    qbTax: 111.15,
    qbTotal: 1699.07,
    note: "8% sobre 11 líneas — el caso que más redondeos por línea acumula",
  },
  {
    displayId: 2584,
    qbDoc: "Invoice 19568 (TxnID 1C9CEF-1784039103, 2026-07-14)",
    qbGrossSubtotal: 3798.18,
    qbDiscount: 303.85,
    qbNetSubtotal: 3494.33,
    qbRate: 7,
    qbTax: 244.6,
    qbTotal: 3738.93,
    note: "8%, 9 líneas, incluye un SKU repetido con dos precios distintos",
  },
  {
    displayId: 2538,
    qbDoc: "Invoice 18956 (TxnID 1C91E4-1783098654, 2026-07-03)",
    qbGrossSubtotal: 218.75,
    qbDiscount: 17.5,
    qbNetSubtotal: 201.25,
    qbRate: 7,
    qbTax: 14.09,
    qbTotal: 215.34,
    note: "8% redondo (17.50 exacto) — el control donde el redondeo no opina",
  },
  {
    displayId: 1493,
    qbDoc: "Invoice 18782 (TxnID 1C5995-1779906248, 2026-05-27)",
    qbGrossSubtotal: 4025.02,
    qbDiscount: 503.14,
    qbNetSubtotal: 3521.88,
    qbRate: 0,
    qbTax: 0,
    qbTotal: 3521.88,
    note: "cliente EXENTO con descuento del 13% en QB (12.5% en el POS)",
  },
  {
    displayId: 2465,
    qbDoc: "SalesReceipt 28505 (2026-06-29)",
    qbGrossSubtotal: 291.48,
    qbDiscount: 29.15,
    qbNetSubtotal: 262.33,
    qbRate: 7,
    qbTax: 18.36,
    qbTotal: 280.69,
    note: "10% — el .5 del redondeo cae justo (29.148 → 29.15)",
  },
  {
    displayId: 2773,
    qbDoc: "SalesReceipt 28691 (2026-07-23)",
    qbGrossSubtotal: 1065.66,
    qbDiscount: 85.25,
    qbNetSubtotal: 980.41,
    qbRate: 7,
    qbTax: 68.63,
    qbTotal: 1049.04,
    note: "8%, 8 líneas, sales receipt",
  },
  {
    displayId: 2861,
    qbDoc: "SalesReceipt 28739 (2026-07-29)",
    qbGrossSubtotal: 1491.75,
    qbDiscount: 149.18,
    qbNetSubtotal: 1342.57,
    qbRate: 0,
    qbTax: 0,
    qbTotal: 1342.57,
    note: "10% exento, UNA línea de qty 65 — aísla el redondeo del descuento",
  },
];

const CENT = 0.005;

function money(n: number | null | undefined): string {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

function delta(a: number, b: number | null | undefined): string {
  if (b == null) return "—";
  const d = Math.round((a - b) * 100) / 100;
  if (Math.abs(d) < CENT) return "=";
  return `${d > 0 ? "+" : ""}${d.toFixed(2)}`;
}

function resolveDatabaseUrl(): string {
  const fromEnv = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  // El shell de Avernuz xterm filtra un DATABASE_URL que apunta a otra base, así
  // que leer el .env es más confiable que confiar en el environ heredado.
  const env = readFileSync(join(process.cwd(), ".env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("no DATABASE_URL: ni en env ni en backend/.env");
  return line.slice("DATABASE_URL=".length).trim();
}

type StoredTotals = {
  orderId: string;
  computedTotal: number | null;
  posTotal: number | null;
  summaryTotal: number | null;
  invoiceTotal: number | null;
  discountType: string | null;
  discountValue: number | null;
  taxRate: number | null;
};

async function loadStored(
  pool: Pool,
  displayId: number
): Promise<StoredTotals | null> {
  const { rows } = await pool.query<{
    id: string;
    computed_total: string | null;
    pos_total: string | null;
    summary_total: string | null;
    invoice_total: string | null;
    discount_type: string | null;
    discount_value: string | null;
    tax_rate: string | null;
  }>(
    `SELECT o.id,
            NULLIF(o.metadata->>'computed_total','')      AS computed_total,
            NULLIF(o.metadata->>'pos_total','')           AS pos_total,
            NULLIF(os.totals->>'current_order_total','')  AS summary_total,
            -- El invoice es el documento EMITIDO; si existe, manda sobre
            -- cualquier campo de la orden y es lo que se mandó a QB.
            (SELECT SUM(i.total)::text FROM pos_invoice i
              WHERE i.order_id = o.id AND i.status <> 'voided'
                AND i.deleted_at IS NULL)                 AS invoice_total,
            NULLIF(o.metadata->>'discount_type','')       AS discount_type,
            NULLIF(o.metadata->>'discount_value','')      AS discount_value,
            NULLIF(o.metadata->>'pos_tax_rate','')        AS tax_rate
       FROM "order" o
       JOIN order_summary os
         ON os.order_id = o.id AND os.version = o.version
      WHERE o.display_id = $1
      LIMIT 1`,
    [displayId]
  );
  const r = rows[0];
  if (!r) return null;
  const num = (v: string | null): number | null =>
    v == null ? null : Number(v);
  return {
    orderId: r.id,
    computedTotal: num(r.computed_total),
    posTotal: num(r.pos_total),
    summaryTotal: num(r.summary_total),
    // pos_invoice.total está en CENTAVOS.
    invoiceTotal:
      r.invoice_total == null ? null : Number(r.invoice_total) / 100,
    discountType: r.discount_type,
    discountValue: num(r.discount_value),
    taxRate: num(r.tax_rate),
  };
}

type Failure = { doc: string; what: string; detail: string };

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: resolveDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  const failures: Failure[] = [];
  const skipped: string[] = [];

  try {
    console.log(
      "\nE2E — total de orden con descuento vs QuickBooks (read-only)\n" +
        "=".repeat(78)
    );

    for (const f of FIXTURES) {
      const stored = await loadStored(pool, f.displayId);
      const label = `#${f.displayId} · ${f.qbDoc}`;
      if (!stored) {
        skipped.push(`${label} — la orden no existe en esta base`);
        continue;
      }

      const base = await loadOrderMoneyBase(pool, stored.orderId);

      // El descuento que le llega a la derivación es el mismo que le llegaría a
      // `post-edit-sync`: el monto en dólares que el POS calculó. Se reconstruye
      // desde el bruto de QB para no depender de un campo de la orden que puede
      // guardar un PORCENTAJE (5) en vez de un monto (2.65).
      const discountDollars = f.qbDiscount;

      const parity = resolveQbParityTax(base, discountDollars, f.qbRate);
      const resolved = resolvePatchedOrderTotal({
        base,
        posTaxAmount: parity.tax,
        discount: discountDollars,
      });

      console.log(`\n${label}`);
      console.log(`  ${f.note}`);
      console.log(
        `  QB      bruto ${money(f.qbGrossSubtotal)} · desc −${f.qbDiscount.toFixed(2)} · ` +
          `neto ${money(f.qbNetSubtotal)} · tax ${money(f.qbTax)} @ ${f.qbRate}% · TOTAL ${money(f.qbTotal)}`
      );

      if (!resolved.ok) {
        console.log(`  DERIVADO ❌ se NEGÓ a derivar: ${resolved.reason}`);
        failures.push({
          doc: label,
          what: "derivación rechazada",
          detail: resolved.reason,
        });
        continue;
      }

      console.log(
        `  base    neto ${money(base.netDollars)} · imponible ${money(base.taxableNetDollars)} · ` +
          `envío ${money(base.shippingDollars)} · adj ${money(base.adjustmentsDollars)} · ` +
          `horneado ${money(base.bakedDiscountDollars)}`
      );
      console.log(
        `  DERIVADO tax ${money(parity.tax)} sobre ${money(parity.taxableBase)} · ` +
          `TOTAL ${money(resolved.total)}   (Δ vs QB ${delta(resolved.total, f.qbTotal)})`
      );
      console.log(
        `  GUARDADO computed_total ${money(stored.computedTotal)} (Δ ${delta(f.qbTotal, stored.computedTotal)}) · ` +
          `pos_total ${money(stored.posTotal)} (Δ ${delta(f.qbTotal, stored.posTotal)}) · ` +
          `summary ${money(stored.summaryTotal)} (Δ ${delta(f.qbTotal, stored.summaryTotal)}) · ` +
          `invoice ${money(stored.invoiceTotal)} (Δ ${delta(f.qbTotal, stored.invoiceTotal)})`
      );
      for (const w of resolved.warnings) console.log(`  ⚠️  ${w}`);

      // ── Aserciones ────────────────────────────────────────────────────────
      // 1. El impuesto: QB redondea una vez sobre el agregado imponible.
      if (Math.abs(parity.tax - f.qbTax) >= CENT) {
        failures.push({
          doc: label,
          what: "tax derivado ≠ QB",
          detail: `derivado ${money(parity.tax)} vs QB ${money(f.qbTax)}`,
        });
      }
      // 2. El total derivado es el que QB facturó.
      if (Math.abs(resolved.total - f.qbTotal) >= CENT) {
        failures.push({
          doc: label,
          what: "total derivado ≠ QB",
          detail: `derivado ${money(resolved.total)} vs QB ${money(f.qbTotal)}`,
        });
      }
      // 3. El campo que la lista /orders muestra hoy (computed_total gana) es
      //    el que QB facturó. Un campo ausente NO es un fallo: la orden puede
      //    ser anterior al backfill y caer al fallback.
      if (
        stored.computedTotal != null &&
        Math.abs(stored.computedTotal - f.qbTotal) >= CENT
      ) {
        failures.push({
          doc: label,
          what: "computed_total guardado ≠ QB",
          detail: `guardado ${money(stored.computedTotal)} vs QB ${money(f.qbTotal)} — es lo que muestra la columna TOTAL de /orders`,
        });
      }
      // 4. Los campos guardados no se contradicen entre sí. Dos pantallas del
      //    mismo documento con dos totales distintos es el defecto original.
      const present = [
        ["computed_total", stored.computedTotal],
        ["pos_total", stored.posTotal],
      ] as const;
      for (const [nameA, a] of present) {
        for (const [nameB, b] of present) {
          if (nameA >= nameB || a == null || b == null) continue;
          if (Math.abs(a - b) >= CENT) {
            failures.push({
              doc: label,
              what: `${nameA} ≠ ${nameB}`,
              detail: `${money(a)} vs ${money(b)} — la misma orden muestra dos totales según la pantalla`,
            });
          }
        }
      }
      // 5. El invoice emitido es el documento que el cliente tiene en la mano.
      if (
        stored.invoiceTotal != null &&
        Math.abs(stored.invoiceTotal - f.qbTotal) >= CENT
      ) {
        failures.push({
          doc: label,
          what: "pos_invoice.total ≠ QB",
          detail: `invoice ${money(stored.invoiceTotal)} vs QB ${money(f.qbTotal)}`,
        });
      }
    }

    console.log(`\n${"=".repeat(78)}`);
    for (const s of skipped) console.log(`⏭️  SKIP  ${s}`);
    if (failures.length === 0) {
      console.log(
        `✅ PASS — ${FIXTURES.length - skipped.length} documentos con descuento ` +
          `coinciden con QuickBooks al centavo.`
      );
      return;
    }
    console.log(`❌ FAIL — ${failures.length} discrepancia(s):\n`);
    for (const f of failures) {
      console.log(`   ${f.doc}\n     ${f.what}: ${f.detail}`);
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
