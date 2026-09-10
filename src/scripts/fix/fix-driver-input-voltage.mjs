#!/usr/bin/env node
/**
 * Correct the AC input voltage stated in product.description and
 * variant.metadata.sales_description for 9 drivers, from their datasheets
 * (backlighting/docs/datasheets/Drivers/*.pdf, read 2026-09-10).
 *
 * Writes go through the NATIVE admin routes so Meili re-syncs and nothing else
 * changes: POST /admin/products/:id {description} and
 * POST /admin/products/:id/variants/:vid {metadata} — the variant metadata is
 * READ-MODIFY-WRITE (the variant upsert REPLACES metadata wholesale).
 * QuickBooks is NOT touched: the QB item SalesDesc only moves through the POS
 * product workflow, which is out of scope here.
 *
 *   node src/scripts/fix/fix-driver-input-voltage.mjs            # dry-run
 *   ADMIN_TOKEN=… node src/scripts/fix/fix-driver-input-voltage.mjs --apply
 */
const BACKEND_URL = (process.env.BACKEND_URL || "https://medusa-starter-default-production-b69e.up.railway.app").replace(/\/$/, "");
const TOKEN = process.env.ADMIN_TOKEN;
const APPLY = process.argv.includes("--apply");

// sku → [wrong substring (case-insensitive), correct value] per the datasheet
const FIXES = {
  "EPS-JDA2-192-24": ["100-277VAC", "110-277VAC"],
  "EPS-JDA2-288-24": ["100-277VAC", "120-277VAC"],
  "EPS-JDA2-384-24": ["100-277VAC", "120-277VAC"],
  "EPS-JNA-200-24":  ["100-277VAC", "120-277VAC"],
  "EPS-JNA-300-24":  ["100-277VAC", "120-277VAC"],
  "EPS-MDA-96-24":   ["100-277VAC", "120VAC"],
  "EPS-MDA-60-24":   ["100-120VAC", "120VAC"],
  "XLG-200-24-A":    ["90-305VAC",  "100-305VAC"],
  "XLG-320-V-A":     ["90-305VAC",  "100-305VAC"],
  // EasyLED Slim drivers: no datasheet in the repo; value stated by the operator 2026-09-10.
  "EPS-SPR-D2024":   ["100-277VAC", "120-240VAC"],
  "EPS-SPR-D4024":   ["100-277VAC", "120-240VAC"],
  "EPS-SPR-D6024":   ["100-277VAC", "120-240VAC"],
  "EPS-SPR-D9024":   ["100-277VAC", "120-240VAC"],
};

if (APPLY && !TOKEN) { console.error("ADMIN_TOKEN required for --apply"); process.exit(2); }
const headers = { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };
const get = async (p) => { const r = await fetch(BACKEND_URL + p, { headers }); if (!r.ok) throw new Error(`GET ${p} → ${r.status}`); return r.json(); };
const post = async (p, b) => { const r = await fetch(BACKEND_URL + p, { method: "POST", headers, body: JSON.stringify(b) }); if (!r.ok) throw new Error(`POST ${p} → ${r.status} ${await r.text()}`); return r.json(); };

const replaceVoltage = (text, wrong, right) => {
  if (!text) return text;
  // "90-305V" / "90-305VAC" / "100-277Vac" — tolerate the AC suffix variations seen in the data
  const core = wrong.replace(/VAC$/i, "");
  return text.replace(new RegExp(core.replace("-", "\\s*-\\s*") + "\\s*V(AC)?", "gi"), right);
};

if (!TOKEN) { console.log("dry-run without token: would fix", Object.keys(FIXES).length, "SKUs"); process.exit(0); }

let changed = 0;
for (const [sku, [wrong, right]] of Object.entries(FIXES)) {
  const { products } = await get(`/admin/products?fields=id,handle,description,*variants,*variants.metadata&limit=5&q=${encodeURIComponent(sku)}`);
  const product = products.find((p) => p.variants?.some((v) => v.sku === sku));
  if (!product) { console.log(`?? ${sku}: not found`); continue; }
  const variant = product.variants.find((v) => v.sku === sku);
  const newDesc = replaceVoltage(product.description, wrong, right);
  const sd = variant.metadata?.sales_description;
  const newSd = replaceVoltage(sd, wrong, right);
  const descChanged = newDesc !== product.description;
  const sdChanged = newSd !== sd;
  console.log(`${sku}: description ${descChanged ? "✎" : "="} · sales_description ${sdChanged ? "✎" : "="}`);
  if (sdChanged) console.log(`   - ${sd}\n   + ${newSd}`);
  if (!APPLY) continue;
  if (descChanged) await post(`/admin/products/${product.id}`, { description: newDesc });
  if (sdChanged) await post(`/admin/products/${product.id}/variants/${variant.id}`, { metadata: { ...variant.metadata, sales_description: newSd } });
  if (descChanged || sdChanged) changed++;
}
console.log(`\n${APPLY ? "changed" : "would change"} ${APPLY ? changed : "(see above)"} · mode=${APPLY ? "APPLY" : "dry-run"}`);
