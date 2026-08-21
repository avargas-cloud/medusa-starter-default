import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

import { PRODUCT_ATTRIBUTES_MODULE } from "../../modules/product-attributes";

// Step: Diff & Update Links
const updateLinksStep = createStep(
  "update-attribute-links",
  async (
    { productId, valueIds }: { productId: string; valueIds: string[] },
    { container }
  ) => {
    const remoteLink = container.resolve("remoteLink");
    const query = container.resolve("query");

    // 1. Fetch current links using Query Graph
    // 1. Fetch current links using Query Graph (Direct Pivot Query)
    // Traversing product -> attribute_value is brittle if the link name isn't exact.
    // Querying the pivot table "product_attribute_value" is robust.
    const { data: links } = await query.graph({
      entity: "product_attribute_value",
      fields: ["attribute_value_id"],
      filters: { product_id: productId },
    });

    const currentIds = links.map((l: any) => l.attribute_value_id);

    console.log("🔍 [WORKFLOW DEBUG] Update Attributes:");
    console.log("   - Product ID:", productId);
    console.log("   - Existing Link Count:", links.length);
    console.log("   - Incoming Count:", valueIds.length);

    // 2. Fetch full attribute value details to get attribute_key information
    const { data: existingValues } = await query.graph({
      entity: "attribute_value",
      fields: ["id", "attribute_key_id"],
      filters: { id: currentIds },
    });

    const { data: incomingValues } = await query.graph({
      entity: "attribute_value",
      fields: ["id", "attribute_key_id"],
      filters: { id: valueIds },
    });

    // 3. Group by attribute_key to detect which keys changed
    const existingByKey = new Map<string, string[]>();
    existingValues.forEach((v: any) => {
      if (!existingByKey.has(v.attribute_key_id)) {
        existingByKey.set(v.attribute_key_id, []);
      }
      existingByKey.get(v.attribute_key_id)!.push(v.id);
    });

    const incomingByKey = new Map<string, string[]>();
    incomingValues.forEach((v: any) => {
      if (!incomingByKey.has(v.attribute_key_id)) {
        incomingByKey.set(v.attribute_key_id, []);
      }
      incomingByKey.get(v.attribute_key_id)!.push(v.id);
    });

    // 4. For each key that exists in incoming: DELETE old values ONLY if they changed
    const toDelete: string[] = [];
    console.log(
      `\n🔍 Comparing ${incomingByKey.size} incoming keys vs ${existingByKey.size} existing keys`
    );
    incomingByKey.forEach((newValueIds, keyId) => {
      const oldValueIds = existingByKey.get(keyId) || [];

      // Compare sets - only delete if values changed
      const newSet = new Set(newValueIds);
      const oldSet = new Set(oldValueIds);
      const unchanged =
        newSet.size === oldSet.size &&
        [...newSet].every((id) => oldSet.has(id));

      console.log(
        `   ${keyId.slice(0, 10)}: old=${oldValueIds.length} new=${newValueIds.length} ${unchanged ? "✅" : "🔄"}`
      );

      // If same size and all IDs match, skip (no change)
      if (unchanged) {
        return;
      }

      // Values changed — delete ONLY the ones removed from the key. Borrar
      // TODOS los viejos era asimétrico con toCreate (que sólo crea los
      // netos-nuevos): los valores RETENIDOS se borraban y nunca se
      // recreaban — agregar 5000K a una key con 4 CCTs dejaba el producto
      // con SOLO 5000K (pérdida de datos, cazada 2026-08-21 en sandbox).
      toDelete.push(...oldValueIds.filter((id) => !newSet.has(id)));
    });

    // 5. Also delete values from keys that are NO LONGER in the incoming set
    existingByKey.forEach((oldValues, keyId) => {
      if (!incomingByKey.has(keyId)) {
        toDelete.push(...oldValues);
      }
    });

    const toCreate = valueIds.filter((id) => !currentIds.includes(id));

    console.log(`   - To Create: ${toCreate.length} attributes`);
    console.log(
      `   - To Delete: ${toDelete.length} attributes (cleaning up changed keys)`
    );
    if (toDelete.length > 0) {
      console.log("   ⚠️  WILL DELETE:", toDelete);
    }

    const promises: Promise<any>[] = [];

    if (toDelete.length > 0) {
      // ✅ HARD DELETE using RAW SQL
      // remoteLink.delete() is BROKEN - it deletes ALL product links regardless of IDs
      // Using raw SQL ensures we only delete specific attribute_value_ids
      const knex = container.resolve("__pg_connection__");

      promises.push(
        knex("product_product_productattributes_attribute_value")
          .where("product_id", productId)
          .whereIn("attribute_value_id", toDelete)
          .del() // Hard delete
      );
    }

    if (toCreate.length > 0) {
      promises.push(
        remoteLink.create(
          toCreate.map((id) => ({
            [Modules.PRODUCT]: { product_id: productId },
            [PRODUCT_ATTRIBUTES_MODULE]: { attribute_value_id: id },
          }))
        )
      );
    }

    await Promise.all(promises);

    return new StepResponse(valueIds, { oldIds: currentIds });
  },
  async (_input, { container: _container }) => {
    // Rollback logic (omitted for brevity)
  }
);

import { updateProductMetadataStep } from "./steps/update-product-metadata";

export const updateProductAttributesWorkflow = createWorkflow(
  "update-product-attributes",
  (input: { productId: string; valueIds: string[]; variantKeys: string[] }) => {
    updateLinksStep(input);

    updateProductMetadataStep({
      productId: input.productId,
      variantKeys: input.variantKeys,
    });

    return new WorkflowResponse(input);
  }
);
