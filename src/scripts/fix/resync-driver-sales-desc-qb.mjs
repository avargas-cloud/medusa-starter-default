#!/usr/bin/env node
/**
 * Push the corrected sales_description of the 13 drivers to QuickBooks as an
 * ItemInventoryMod (SalesDesc only), through the SAME route the POS uses when an
 * operator saves a product: POST /admin/pos/products/:productId { variant_id, salesDescription }.
 * The workflow builds a "mod" carrying only the fields present, so price, cost,
 * vendor and accounts are NOT touched. Every variant already has quickbooks_id
 * (verified 2026-09-10), so nothing here can turn into an ADD.
 *
 *   node src/scripts/fix/resync-driver-sales-desc-qb.mjs                 # dry-run
 *   ADMIN_TOKEN=… node src/scripts/fix/resync-driver-sales-desc-qb.mjs --apply
 *
 * After --apply, the item pipeline confirms each op within ~1-2 min; check the
 * POS sync status or `qb_item_pipeline` for the printed pipeline_row_id.
 */
const BACKEND_URL = (process.env.BACKEND_URL || "https://medusa-starter-default-production-b69e.up.railway.app").replace(/\/$/, "");
const TOKEN = process.env.ADMIN_TOKEN;
const APPLY = process.argv.includes("--apply");
const SKUS = ["EPS-JDA2-192-24","EPS-JDA2-288-24","EPS-JDA2-384-24","EPS-JNA-200-24","EPS-JNA-300-24","EPS-MDA-96-24","EPS-MDA-60-24","XLG-200-24-A","XLG-320-V-A","EPS-SPR-D2024","EPS-SPR-D4024","EPS-SPR-D6024","EPS-SPR-D9024"];

if (!TOKEN) { console.log(`dry-run without token: would resync SalesDesc of ${SKUS.length} SKUs to QB. Set ADMIN_TOKEN.`); process.exit(APPLY ? 2 : 0); }
const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const get = async (p) => { const r = await fetch(BACKEND_URL + p, { headers }); if (!r.ok) throw new Error(`GET ${p} → ${r.status}`); return r.json(); };
const post = async (p, b) => { const r = await fetch(BACKEND_URL + p, { method: "POST", headers, body: JSON.stringify(b) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`POST ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };

let queued = 0, failed = 0;
for (const sku of SKUS) {
  try {
    const { products } = await get(`/admin/products?fields=id,handle,*variants,*variants.metadata&limit=5&q=${encodeURIComponent(sku)}`);
    const product = products.find((p) => p.variants?.some((v) => v.sku === sku));
    const variant = product?.variants.find((v) => v.sku === sku);
    if (!product || !variant) { console.log(`?? ${sku}: not found`); failed++; continue; }
    const sd = variant.metadata?.sales_description;
    if (!sd) { console.log(`?? ${sku}: no sales_description`); failed++; continue; }
    if (!variant.metadata?.quickbooks_id) { console.log(`!! ${sku}: no quickbooks_id — would be an ADD, skipping`); failed++; continue; }
    console.log(`${sku}: ${APPLY ? "→ QB mod" : "would send"} SalesDesc = ${sd}`);
    if (!APPLY) continue;
    const res = await post(`/admin/pos/products/${product.id}`, { variant_id: variant.id, salesDescription: sd });
    console.log(`   qb_op_queued=${res.qb_op_queued} op=${res.qbOperationId ?? "-"} pipeline_row=${res.pipeline_row_id ?? "-"}`);
    if (res.qb_op_queued) queued++; else failed++;
  } catch (e) { console.log(`FAILED ${sku}: ${e.message}`); failed++; }
}
console.log(`\n${APPLY ? "queued" : "would queue"} ${APPLY ? queued : SKUS.length - failed} · problems ${failed} · mode=${APPLY ? "APPLY" : "dry-run"}`);
process.exit(failed ? 1 : 0);
