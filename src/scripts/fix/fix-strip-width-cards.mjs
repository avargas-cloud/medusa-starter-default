#!/usr/bin/env node
/**
 * Fix the "Strip Width" feature card in two legacy long_descriptions whose text
 * (and in one case image) contradicted the SKU / sales_description:
 *   - 65ft SMD2835 (ESPS1L4N96W10xx): card said 8mm, strip is 10mm (image already 10mm)
 *   - Narrow strip (ESPS9R4N50W04xx): card said 5mm with a 5mm icon, strip is 4mm
 *     → new icon legacy/wp/wp-content/uploads/2022/01/strip-width-4mm-1.jpg (mirrored 2026-09-10)
 * Product metadata deep-merges on the native route, so only long_description is sent.
 *
 *   node src/scripts/fix/fix-strip-width-cards.mjs            # dry-run
 *   ADMIN_TOKEN=… node src/scripts/fix/fix-strip-width-cards.mjs --apply
 */
const BACKEND_URL = (process.env.BACKEND_URL || "https://medusa-starter-default-production-b69e.up.railway.app").replace(/\/$/, "");
const TOKEN = process.env.ADMIN_TOKEN; const APPLY = process.argv.includes("--apply");
const FIXES = {
  "65ft-ul-smd2835-led-strip-2400-single-color-chips-bright-output": [
    ["<h2>8mm Strip Width</h2>", "<h2>10mm Strip Width</h2>"],
    ["width of 8mm", "width of 10mm"],
  ],
  "led-strips-narrow-2400led-4mm": [
    ["<h2>5mm Strip Width</h2>", "<h2>4mm Strip Width</h2>"],
    ["width of 5mm", "width of 4mm"],
    [/strip-width-5mm-1(-\d+x\d+)?\.jpg/g, "strip-width-4mm-1.jpg"],
  ],
};
if (!TOKEN) { console.log("dry-run without token"); process.exit(0); }
const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
for (const [handle, reps] of Object.entries(FIXES)) {
  const r = await fetch(`${BACKEND_URL}/admin/products?handle=${handle}&fields=id,handle,metadata`, { headers }); const { products } = await r.json();
  const p = products?.[0]; if (!p) { console.log("?? not found", handle); continue; }
  let ld = p.metadata?.long_description || ""; const before = ld;
  for (const [a, b] of reps) ld = ld.replace(a, b);
  const changed = ld !== before;
  console.log(`${handle}: ${changed ? "✎" : "= (nothing to change)"}`);
  for (const [a] of reps) console.log(`   ${String(a)} → ${before.match(a) ? "found" : "NOT FOUND"}`);
  if (APPLY && changed) {
    const u = await fetch(`${BACKEND_URL}/admin/products/${p.id}`, { method: "POST", headers, body: JSON.stringify({ metadata: { long_description: ld } }) });
    console.log(`   POST → ${u.status}`);
  }
}
console.log(`mode=${APPLY ? "APPLY" : "dry-run"}`);
