import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";
import * as http from "node:http";

import { updatePosProductWorkflow } from "../../workflows/pos/update-pos-product";

const PRODUCT_ID = "product_01KGAX7RCX5K34Y1DZSTBTF717"; // 8-variant wall plate

function startMockQbBridge(port: number): http.Server {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          operationId: `mock-op-${Date.now()}`,
          status: "queued",
        })
      );
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

type VariantSnapshot = {
  id: string;
  sku: string | null;
  title: string;
  weight: number | null;
  mid_code: string | null;
  metadata: Record<string, unknown> | null;
};

async function snapshotVariants(query: any, productId: string): Promise<VariantSnapshot[]> {
  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "title", "weight", "mid_code", "metadata"],
    filters: { product_id: productId, deleted_at: null as any },
  });
  return (data as VariantSnapshot[]).sort((a, b) => a.id.localeCompare(b.id));
}

function variantById(snap: VariantSnapshot[], id: string): VariantSnapshot | undefined {
  return snap.find((v) => v.id === id);
}

function assert(cond: boolean, label: string, detail?: string): boolean {
  if (cond) {
    console.log(`  ✅ ${label}`);
    return true;
  }
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

let totalPass = 0;
let totalFail = 0;
function record(passed: boolean) {
  if (passed) totalPass++;
  else totalFail++;
}

export default async function ({ container }: ExecArgs) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const productModule = container.resolve(Modules.PRODUCT) as IProductModuleService;
  const link = container.resolve(ContainerRegistrationKeys.LINK);

  // Override the env URL so the workflow points to our in-process mock that
  // returns 200 for every QB op. Avoids the sandbox QB_BRIDGE_URL=disabled
  // fetch failure which would trigger workflow compensation and revert our DB
  // writes (separate failure mode from the sibling-wipe bug under test).
  const mockPort = 9911;
  process.env.QB_BRIDGE_URL = `http://127.0.0.1:${mockPort}`;
  const mockServer = startMockQbBridge(mockPort);
  console.log(`Mock QB bridge listening on http://127.0.0.1:${mockPort}`);

  console.log("═".repeat(70));
  console.log("update-pos-product workflow — sibling-survival test matrix");
  console.log("═".repeat(70));

  const baselineProduct = (
    await query.graph({
      entity: "product",
      fields: ["id", "title"],
      filters: { id: PRODUCT_ID },
    })
  ).data[0] as any;
  const baseline = await snapshotVariants(query, PRODUCT_ID);
  console.log(`\nProduct: ${baselineProduct.title} (${PRODUCT_ID})`);
  console.log(`Starting variant count: ${baseline.length}`);
  if (baseline.length < 4) {
    console.error("Need at least 4 variants — abort.");
    return;
  }

  // ─── TEST 1: edit ONE variant of multi-variant product ─────────────────
  console.log("\n▶ TEST 1: edit ONE variant — siblings must survive (THE FIX)");
  const target1 = baseline[0];
  const newSku1 = `${target1.sku}-T1`;
  await updatePosProductWorkflow(container).run({
    input: { id: PRODUCT_ID, variant_id: target1.id, sku: newSku1 },
    throwOnError: false,
  });
  let after = await snapshotVariants(query, PRODUCT_ID);
  record(assert(after.length === baseline.length, `variant count unchanged (${after.length}/${baseline.length})`, `had ${baseline.length}, now ${after.length}`));
  record(assert(variantById(after, target1.id)?.sku === newSku1, `target SKU updated to ${newSku1}`));
  for (const v of baseline.slice(1)) {
    const a = variantById(after, v.id);
    record(assert(!!a && a.sku === v.sku, `sibling ${v.title} (${v.sku}) preserved`, `now ${a?.sku ?? "GONE"}`));
  }

  // ─── TEST 2: edit ONE variant — change multiple fields ─────────────────
  console.log("\n▶ TEST 2: edit ONE variant — multi-field patch");
  const target2 = baseline[1];
  await updatePosProductWorkflow(container).run({
    input: {
      id: PRODUCT_ID,
      variant_id: target2.id,
      weight: 42,
      mid_code: "TEST-MPN-2",
      salesDescription: "T2 sales desc",
      cost: 99.99,
    },
    throwOnError: false,
  });
  after = await snapshotVariants(query, PRODUCT_ID);
  record(assert(after.length === baseline.length, "variant count unchanged"));
  const t2 = variantById(after, target2.id);
  record(assert(t2?.weight === 42, "weight updated"));
  record(assert(t2?.mid_code === "TEST-MPN-2", "mid_code updated"));
  const t2meta = (t2?.metadata ?? {}) as Record<string, unknown>;
  record(assert(t2meta.sales_description === "T2 sales desc", "metadata.sales_description updated"));
  record(assert(t2meta.qb_purchase_cost === 99.99, "metadata.qb_purchase_cost updated"));

  // ─── TEST 3: edit product-level fields only ────────────────────────────
  console.log("\n▶ TEST 3: edit product-level (title) — no variant_id changes");
  const target3 = baseline[2];
  const newTitle = `${baselineProduct.title} [T3]`;
  await updatePosProductWorkflow(container).run({
    input: { id: PRODUCT_ID, variant_id: target3.id, title: newTitle },
    throwOnError: false,
  });
  after = await snapshotVariants(query, PRODUCT_ID);
  const updatedProduct = (
    await query.graph({
      entity: "product",
      fields: ["title"],
      filters: { id: PRODUCT_ID },
    })
  ).data[0] as any;
  record(assert(updatedProduct.title === newTitle, "product title updated"));
  record(assert(after.length === baseline.length, "variant count unchanged"));

  // ─── TEST 4: edit product + variant combined ───────────────────────────
  console.log("\n▶ TEST 4: combined product+variant patch");
  const target4 = baseline[3];
  const newTitle2 = `${baselineProduct.title} [T4]`;
  await updatePosProductWorkflow(container).run({
    input: {
      id: PRODUCT_ID,
      variant_id: target4.id,
      title: newTitle2,
      mpn: "T4-COMBINED-MPN",
    },
    throwOnError: false,
  });
  after = await snapshotVariants(query, PRODUCT_ID);
  const t4Product = (
    await query.graph({ entity: "product", fields: ["title"], filters: { id: PRODUCT_ID } })
  ).data[0] as any;
  record(assert(t4Product.title === newTitle2, "product title updated"));
  const t4 = variantById(after, target4.id);
  const t4meta = (t4?.metadata ?? {}) as Record<string, unknown>;
  record(assert(t4meta.mpn === "T4-COMBINED-MPN", "variant metadata.mpn updated"));
  record(assert(after.length === baseline.length, "variant count unchanged"));

  // ─── TEST 5: edit different variants in sequence — independence ────────
  console.log("\n▶ TEST 5: 3 sequential edits of different variants");
  for (let i = 4; i < 7 && i < baseline.length; i++) {
    const v = baseline[i];
    await updatePosProductWorkflow(container).run({
      input: { id: PRODUCT_ID, variant_id: v.id, mid_code: `SEQ-${i}` },
      throwOnError: false,
    });
  }
  after = await snapshotVariants(query, PRODUCT_ID);
  record(assert(after.length === baseline.length, `variant count unchanged after 3 sequential edits`));
  for (let i = 4; i < 7 && i < baseline.length; i++) {
    const v = variantById(after, baseline[i].id);
    record(assert(v?.mid_code === `SEQ-${i}`, `variant ${i} mid_code=SEQ-${i}`));
  }

  // ─── TEST 6: create fresh product + add/delete variants ────────────────
  console.log("\n▶ TEST 6: fresh product create → add 4th variant → delete it");
  const stamp = Date.now();
  const freshProduct = await productModule.createProducts({
    title: `TEST-CRUD-${stamp}`,
    handle: `test-crud-${stamp}`,
    status: "draft",
    options: [{ title: "Color", values: ["Red", "Green", "Blue"] }],
    variants: [
      { title: "Red", sku: `TEST-R-${stamp}`, manage_inventory: false, allow_backorder: false, options: { Color: "Red" } },
      { title: "Green", sku: `TEST-G-${stamp}`, manage_inventory: false, allow_backorder: false, options: { Color: "Green" } },
      { title: "Blue", sku: `TEST-B-${stamp}`, manage_inventory: false, allow_backorder: false, options: { Color: "Blue" } },
    ],
  } as any);
  const freshId = (freshProduct as { id: string }).id;
  let freshSnap = await snapshotVariants(query, freshId);
  record(assert(freshSnap.length === 3, `fresh product has 3 variants (got ${freshSnap.length})`));

  // Add 4th option value (via updateProductOptions on the existing option) +
  // 4th variant linked to that new value.
  const { data: freshOpts } = await query.graph({
    entity: "product_option",
    fields: ["id", "values.value"],
    filters: { product_id: freshId },
  });
  const colorOpt = (freshOpts as any[])[0];
  await productModule.updateProductOptions(colorOpt.id, {
    values: ["Red", "Green", "Blue", "Yellow"],
  } as any);
  const added = await productModule.createProductVariants({
    product_id: freshId,
    title: "Yellow",
    sku: `TEST-Y-${stamp}`,
    manage_inventory: false,
    allow_backorder: false,
    options: { Color: "Yellow" },
  } as any);
  const addedId = (added as { id: string }).id;
  freshSnap = await snapshotVariants(query, freshId);
  record(assert(freshSnap.length === 4, `after add: 4 variants (got ${freshSnap.length})`));
  record(assert(!!variantById(freshSnap, addedId), "4th variant exists"));

  // ─── TEST 7: delete one variant of the 4 — others survive ──────────────
  console.log("\n▶ TEST 7: delete variant — productModule.deleteProductVariants");
  await productModule.deleteProductVariants([addedId]);
  freshSnap = await snapshotVariants(query, freshId);
  record(assert(freshSnap.length === 3, `after delete: 3 variants (got ${freshSnap.length})`));
  record(assert(!variantById(freshSnap, addedId), "deleted variant gone"));

  // Cleanup: drop the fresh test product
  await productModule.deleteProducts([freshId]);

  // ─── TEST 8: regression — edit on single-variant product ───────────────
  console.log("\n▶ TEST 8: regression — edit on single-variant product");
  const { data: singles } = await query.graph({
    entity: "product",
    fields: ["id", "title", "variants.id", "variants.sku"],
    filters: { deleted_at: null as any },
    pagination: { take: 200 },
  });
  const single = (singles as any[]).find((p) => p.variants?.length === 1);
  if (!single) {
    console.log("  (no single-variant product found — skipping)");
  } else {
    const sv = single.variants[0];
    await updatePosProductWorkflow(container).run({
      input: { id: single.id, variant_id: sv.id, weight: 7 },
      throwOnError: false,
    });
    const { data: re } = await query.graph({
      entity: "product_variant",
      fields: ["id", "weight"],
      filters: { product_id: single.id, deleted_at: null as any },
    });
    record(assert(re.length === 1, "single-variant product still has 1 variant"));
    record(assert((re[0] as any).weight === 7, "weight applied"));
  }

  // ─── Final report ──────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(70));
  console.log(`RESULTS: ${totalPass} passed · ${totalFail} failed`);
  console.log("═".repeat(70));
  mockServer.close();
  if (totalFail > 0) process.exitCode = 1;
}
