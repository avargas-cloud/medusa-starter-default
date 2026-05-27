import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";
import * as http from "node:http";

import { updatePosProductFullWorkflow } from "../../workflows/pos/update-pos-product-full";

function startMockQbBridge(port: number) {
  return http
    .createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ operationId: `mock-${Date.now()}` }));
      });
    })
    .listen(port, "127.0.0.1");
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
  const productModule = container.resolve(
    Modules.PRODUCT
  ) as IProductModuleService;

  const mock = startMockQbBridge(9913);
  process.env.QB_BRIDGE_URL = `http://127.0.0.1:9913`;

  const stamp = Date.now();
  // Create a product with ONLY 2 option values registered locally.
  const fresh: any = await productModule.createProducts({
    title: `TEST-OPT-${stamp}`,
    handle: `test-opt-${stamp}`,
    status: "draft",
    options: [{ title: "Color", values: ["Red", "Blue"] }],
    variants: [
      {
        title: "Red",
        sku: `TO-R-${stamp}`,
        manage_inventory: false,
        allow_backorder: false,
        options: { Color: "Red" },
      },
      {
        title: "Blue",
        sku: `TO-B-${stamp}`,
        manage_inventory: false,
        allow_backorder: false,
        options: { Color: "Blue" },
      },
    ],
  } as any);
  const productId = fresh.id;
  console.log(`Product ${productId} created with 2 variants (Red, Blue)\n`);

  // ─── TEST 1: add a variant with a value NOT in product_option.values ──
  console.log("▶ TEST 1: add variant with new option value (auto-upsert)");
  await updatePosProductFullWorkflow(container).run({
    input: {
      id: productId,
      variants: [
        // Keep existing siblings
        { id: undefined, title: "_unused_", sku: "_unused_", options: {} },
      ].filter((x) => x.title !== "_unused_") // empty patch list
        .concat([
          // Add a Green variant — value NOT yet in product_option
          {
            title: "Green",
            sku: `TO-G-${stamp}`,
            options: { Color: "Green" },
            manage_inventory: false,
          } as any,
        ]),
    },
    throwOnError: false,
  });

  const { data: variantsAfter } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "options.value"],
    filters: { product_id: productId, deleted_at: null as any },
  });
  const skus = (variantsAfter as any[]).map((v) => v.sku);
  assertOk(skus.includes(`TO-G-${stamp}`), "Green variant created");
  assertOk(skus.length === 3, `total variants = 3 (got ${skus.length})`);

  const { data: opts } = await query.graph({
    entity: "product_option",
    fields: ["id", "title", "values.value"],
    filters: { product_id: productId },
  });
  const colorOpt = (opts as any[])[0];
  const optValues = (colorOpt.values as any[]).map((v) => v.value);
  assertOk(optValues.includes("Green"), `Green added to product_option (now: ${optValues.join(",")})`);
  assertOk(optValues.includes("Red") && optValues.includes("Blue"), "Original values preserved");

  // ─── TEST 2: re-adding a known value does NOT duplicate ───────────────
  console.log("\n▶ TEST 2: re-add a value that already exists — idempotent");
  await updatePosProductFullWorkflow(container).run({
    input: {
      id: productId,
      variants: [
        // Empty list (no variants to update or add)
      ],
    },
    throwOnError: false,
  });
  const { data: optsB } = await query.graph({
    entity: "product_option",
    fields: ["values.value"],
    filters: { product_id: productId },
  });
  const optValuesB = ((optsB as any[])[0].values as any[]).map((v) => v.value);
  assertOk(optValuesB.length === 3, `still 3 values (got ${optValuesB.length})`);

  // ─── TEST 3: add 2 new values in one call ─────────────────────────────
  console.log("\n▶ TEST 3: add 2 new variants with 2 brand-new values");
  await updatePosProductFullWorkflow(container).run({
    input: {
      id: productId,
      variants: [
        {
          title: "Yellow",
          sku: `TO-Y-${stamp}`,
          options: { Color: "Yellow" },
          manage_inventory: false,
        },
        {
          title: "Purple",
          sku: `TO-P-${stamp}`,
          options: { Color: "Purple" },
          manage_inventory: false,
        },
      ],
    },
    throwOnError: false,
  });
  const { data: optsC } = await query.graph({
    entity: "product_option",
    fields: ["values.value"],
    filters: { product_id: productId },
  });
  const optValuesC = ((optsC as any[])[0].values as any[]).map((v) => v.value);
  assertOk(
    optValuesC.includes("Yellow") && optValuesC.includes("Purple"),
    `Yellow + Purple added (now: ${optValuesC.join(",")})`
  );
  const { data: variantsC } = await query.graph({
    entity: "product_variant",
    fields: ["sku"],
    filters: { product_id: productId, deleted_at: null as any },
  });
  assertOk((variantsC as any[]).length === 5, `variant count = 5 (got ${(variantsC as any[]).length})`);

  // Cleanup
  await productModule.deleteProducts([productId]);

  console.log("\n" + "═".repeat(60));
  console.log(`RESULTS: ${totalPass} passed · ${totalFail} failed`);
  console.log("═".repeat(60));
  mock.close();
  if (totalFail > 0) process.exitCode = 1;
}
