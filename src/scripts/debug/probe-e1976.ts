import { Pool } from "pg";
import { loadOrderMoneyBase, resolveQbParityTax, resolvePatchedOrderTotal } from "../../lib/order-money/order-tax-lines";
const P = new Pool({ connectionString: "postgresql://postgres:sandbox@localhost:5499/medusa" });
(async () => {
  const r = await P.query(`SELECT id FROM "order" WHERE metadata->>'document_number'='E1976'`);
  const base = await loadOrderMoneyBase(P, r.rows[0].id);
  const tax = resolveQbParityTax(base, 0, 7);
  const tot = resolvePatchedOrderTotal({ base, posTaxAmount: tax.tax, discount: 0 });
  console.log(`  subtotal $${base.netDollars}  tax $${tax.tax}  TOTAL $${tot.ok ? tot.total : "?"}   (pantalla: 4829.22)`);
  await P.end();
})();
