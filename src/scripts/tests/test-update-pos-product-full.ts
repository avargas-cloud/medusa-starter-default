import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";
import * as http from "node:http";

import { updatePosProductFullWorkflow } from "../../workflows/pos/update-pos-product-full";

function startMockQbBridge(port: number): http.Server {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ operationId: `mock-op-${Date.now()}`, status: "queued" })
      );
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

async function snapshotVariants(query: any, productId: string) {
  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "title", "weight", "mid_code", "metadata", "options.value", "options.option.title"],
    filters: { product_id: productId, deleted_at: null as any },
  });
  return (data as any[]).sort((a, b) => a.id.localeCompare(b.id));
}

let totalPass = 0;
let totalFail = 0;
function assertOk(cond: boolean, label: string, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    totalPass++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    totalFail++;
  }
}

export default async function ({ container }: ExecArgs) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const productModule = container.resolve(Modules.PRODUCT) as IProductModuleService;

  const mockPort = 9912;
  process.env.QB_BRIDGE_URL = `http://127.0.0.1:${mockPort}`;
  const mockServer = startMockQbBridge(mockPort);
  console.log(`Mock QB bridge on http://127.0.0.1:${mockPort}\n`);

  // ── Create a fresh test product so we don't disturb baseline data ──────
  const stamp = Date.now();
  const fresh: any = await productModule.createProducts({
    title: `TEST-FULL-${stamp}`,
    handle: `test-full-${stamp}`,
    status: "draft",
    options: [{ title: "Color", values: ["Red", "Green", "Blue"] }],
    variants: [
      {
        title: "Red",
        sku: `TF-R-${stamp}`,
        manage_inventory: false,
        allow_backorder: false,
        options: { Color: "Red" },
      },
      {
        title: "Green",
        sku: `TF-G-${stamp}`,
        manage_inventory: false,
        allow_backorder: false,
        options: { Color: "Green" },
      },
      {
        title: "Blue",
        sku: `TF-B-${stamp}`,
        manage_inventory: false,
        allow_backorder: false,
        options: { Color: "Blue" },
      },
    ],
  } as any);
  const productId = fresh.id;
  console.log(`Test product: ${productId} with 3 variants\n`);

  // Add a 4th option value so we can later create variants with it.
  const { data: optsArr } = await query.graph({
    entity: "product_option",
    fields: ["id", "values.id", "values.value"],
    filters: { product_id: productId },
  });
  const colorOpt = (optsArr as any[])[0];
  await productModule.updateProductOptions(colorOpt.id, {
    values: ["Red", "Green", "Blue", "Yellow", "Purple"],
  } as any);

  let snap = await snapshotVariants(query, productId);
  const byColor = (color: string) =>
    snap.find((v: any) =>
      v.options?.some(
        (o: any) => o.option?.title === "Color" && o.value === color
      )
    );

  // ─── TEST 1: edit existing variants (multi-field) ──────────────────────
  console.log("▶ TEST 1: edit existing variants — multi-field patch");
  await updatePosProductFullWorkflow(container).run({
    input: {
      id: productId,
      variants: [
        {
          id: byColor("Red")?.id,
          title: "Red",
          sku: `TF-R-${stamp}-EDITED`,
          weight: 11,
          mpn: "MPN-RED",
        },
        {
          id: byColor("Green")?.id,
          title: "Green",
          sku: `TF-G-${stamp}`,
          mid_code: "MID-GREEN",
          cost: 5,
        },
      ],
    },
    throwOnError: false,
  });
  snap = await snapshotVariants(query, productId);
  assertOk(snap.length === 3, "variant count = 3 (no add/delete)");
  const t1Red = byColor("Red");
  const t1Green = byColor("Green");
  assertOk(t1Red?.sku === `TF-R-${stamp}-EDITED`, "Red SKU updated");
  assertOk(t1Red?.weight === 11, "Red weight=11");
  assertOk((t1Red?.metadata as any)?.mpn === "MPN-RED", "Red metadata.mpn");
  assertOk(t1Green?.mid_code === "MID-GREEN", "Green mid_code");
  assertOk((t1Green?.metadata as any)?.qb_purchase_cost === 5, "Green cost");
  assertOk(!!byColor("Blue"), "Blue untouched and present");

  // ─── TEST 2: add a new variant ─────────────────────────────────────────
  console.log("\n▶ TEST 2: add a new variant (no id)");
  await updatePosProductFullWorkflow(container).run({
    input: {
      id: productId,
      variants: [
        // include existing siblings as patches with no real changes
        { id: byColor("Red")?.id, title: "Red", sku: t1Red?.sku },
        { id: byColor("Green")?.id, title: "Green", sku: t1Green?.sku },
        { id: byColor("Blue")?.id, title: "Blue", sku: byColor("Blue")?.sku },
        // NEW variant — no id
        {
          title: "Yellow",
          sku: `TF-Y-${stamp}`,
          options: { Color: "Yellow" },
          manage_inventory: false,
        },
      ],
    },
    throwOnError: false,
  });
  snap = await snapshotVariants(query, productId);
  assertOk(snap.length === 4, `variant count = 4 (got ${snap.length})`);
  assertOk(!!byColor("Yellow"), "Yellow variant created");
  assertOk(!!byColor("Red") && !!byColor("Green") && !!byColor("Blue"), "RGB siblings preserved");
  const yellow = byColor("Yellow");
  assertOk(yellow?.sku === `TF-Y-${stamp}`, "Yellow SKU correct");

  // ─── TEST 3: delete a variant ──────────────────────────────────────────
  console.log("\n▶ TEST 3: delete a variant (delete_variant_ids)");
  await updatePosProductFullWorkflow(container).run({
    input: {
      id: productId,
      variants: [
        { id: byColor("Red")?.id, title: "Red", sku: byColor("Red")?.sku },
        { id: byColor("Green")?.id, title: "Green", sku: byColor("Green")?.sku },
        { id: byColor("Yellow")?.id, title: "Yellow", sku: byColor("Yellow")?.sku },
      ],
      delete_variant_ids: [byColor("Blue")!.id],
    },
    throwOnError: false,
  });
  snap = await snapshotVariants(query, productId);
  assertOk(snap.length === 3, `variant count = 3 (after delete, got ${snap.length})`);
  assertOk(!byColor("Blue"), "Blue is gone");
  assertOk(!!byColor("Red") && !!byColor("Green") && !!byColor("Yellow"), "R/G/Y preserved");

  // ─── TEST 4: combined add + edit + delete in one call ──────────────────
  console.log("\n▶ TEST 4: combined add + edit + delete");
  await updatePosProductFullWorkflow(container).run({
    input: {
      id: productId,
      variants: [
        { id: byColor("Red")?.id, title: "Red", sku: byColor("Red")?.sku, mid_code: "MID-COMBINED-RED" },
        { id: byColor("Green")?.id, title: "Green", sku: byColor("Green")?.sku },
        // NEW
        {
          title: "Purple",
          sku: `TF-P-${stamp}`,
          options: { Color: "Purple" },
          manage_inventory: false,
        },
      ],
      delete_variant_ids: [byColor("Yellow")!.id],
    },
    throwOnError: false,
  });
  snap = await snapshotVariants(query, productId);
  assertOk(snap.length === 3, `variant count = 3 (got ${snap.length})`);
  assertOk(byColor("Red")?.mid_code === "MID-COMBINED-RED", "Red updated");
  assertOk(!!byColor("Purple"), "Purple created");
  assertOk(!byColor("Yellow"), "Yellow deleted");
  assertOk(!!byColor("Green"), "Green untouched");

  // ─── TEST 5: product-level only (no variants modified) ─────────────────
  console.log("\n▶ TEST 5: product-level title change only");
  const newTitle = `TEST-FULL-${stamp}-RENAMED`;
  await updatePosProductFullWorkflow(container).run({
    input: {
      id: productId,
      title: newTitle,
      variants: [
        { id: byColor("Red")?.id, title: "Red", sku: byColor("Red")?.sku },
        { id: byColor("Green")?.id, title: "Green", sku: byColor("Green")?.sku },
        { id: byColor("Purple")?.id, title: "Purple", sku: byColor("Purple")?.sku },
      ],
    },
    throwOnError: false,
  });
  const { data: updatedProduct } = await query.graph({
    entity: "product",
    fields: ["title"],
    filters: { id: productId },
  });
  assertOk((updatedProduct[0] as any).title === newTitle, "product title updated");
  snap = await snapshotVariants(query, productId);
  assertOk(snap.length === 3, "variant count still 3");

  // ─── TEST 6: empty variants array (defensive) ──────────────────────────
  console.log("\n▶ TEST 6: empty variants[] is a no-op for variants");
  await updatePosProductFullWorkflow(container).run({
    input: { id: productId, variants: [] },
    throwOnError: false,
  });
  snap = await snapshotVariants(query, productId);
  assertOk(snap.length === 3, "variants still 3 after empty edit");

  // ─── TEST 7: delete-only (no variants array entries, only delete list) ─
  console.log("\n▶ TEST 7: delete-only — siblings survive");
  await updatePosProductFullWorkflow(container).run({
    input: {
      id: productId,
      variants: [
        { id: byColor("Red")?.id, title: "Red", sku: byColor("Red")?.sku },
        { id: byColor("Green")?.id, title: "Green", sku: byColor("Green")?.sku },
      ],
      delete_variant_ids: [byColor("Purple")!.id],
    },
    throwOnError: false,
  });
  snap = await snapshotVariants(query, productId);
  assertOk(snap.length === 2, `variant count = 2 (was 3, got ${snap.length})`);
  assertOk(!byColor("Purple"), "Purple deleted");
  assertOk(!!byColor("Red") && !!byColor("Green"), "R/G survive");

  // ─── Cleanup test product ──────────────────────────────────────────────
  await productModule.deleteProducts([productId]);

  console.log("\n" + "═".repeat(70));
  console.log(`RESULTS: ${totalPass} passed · ${totalFail} failed`);
  console.log("═".repeat(70));
  mockServer.close();
  if (totalFail > 0) process.exitCode = 1;
}
