import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";

export type EnsureOptionValuesStepInput = {
  product_id: string;
  /** Each entry: an `options` map a NEW variant intends to use ({ Color: "5000K" }) */
  new_variant_options: Array<Record<string, string>>;
};

export type EnsureOptionValuesStepOutput = {
  added_values: Array<{ option_title: string; value: string }>;
};

/**
 * Ensures every option value referenced by an incoming new variant exists on
 * the product's product_option. Medusa's createProductVariants rejects
 * unknown option values, so this step has to run BEFORE createProductVariantsStep.
 *
 * Idempotent — values already registered are left alone; only missing ones
 * trigger updateProductOptions calls.
 *
 * Compensation: removes the values this step appended (best-effort — Medusa
 * has no API to delete an individual option value by name, so we restore the
 * whole option's value list to its pre-step snapshot).
 */
export const ensureOptionValuesStep = createStep(
  "ensure-option-values-step",
  async (input: EnsureOptionValuesStepInput, { container }) => {
    if (input.new_variant_options.length === 0) {
      return new StepResponse({ added_values: [] }, null);
    }
    const productModule = container.resolve(
      Modules.PRODUCT
    ) as IProductModuleService;
    const query = container.resolve(ContainerRegistrationKeys.QUERY);

    const { data: opts } = await query.graph({
      entity: "product_option",
      fields: ["id", "title", "values.id", "values.value"],
      filters: { product_id: input.product_id },
    });
    const optsByTitle = new Map<
      string,
      { id: string; values: string[] }
    >();
    for (const o of opts as Array<{
      id: string;
      title: string;
      values?: Array<{ value: string }>;
    }>) {
      optsByTitle.set(o.title, {
        id: o.id,
        values: (o.values ?? []).map((v) => v.value),
      });
    }

    // Snapshot original value lists for compensation.
    const originalSnapshot = new Map<string, string[]>();
    for (const [title, opt] of optsByTitle.entries()) {
      originalSnapshot.set(title, [...opt.values]);
    }

    // Collect what's missing per option.
    const missingByOption = new Map<string, Set<string>>();
    for (const variantOpts of input.new_variant_options) {
      for (const [title, value] of Object.entries(variantOpts)) {
        if (!value) continue;
        const opt = optsByTitle.get(title);
        if (!opt) continue;
        if (!opt.values.includes(value)) {
          if (!missingByOption.has(title)) {
            missingByOption.set(title, new Set());
          }
          missingByOption.get(title)!.add(value);
        }
      }
    }

    const added: Array<{ option_title: string; value: string }> = [];
    for (const [title, missing] of missingByOption.entries()) {
      const opt = optsByTitle.get(title)!;
      const merged = [...opt.values, ...Array.from(missing)];
      await productModule.updateProductOptions(opt.id, {
        values: merged,
      } as any);
      for (const v of missing) {
        added.push({ option_title: title, value: v });
      }
    }

    // Compensation payload: which options changed + their original values.
    const compensation = added.length > 0
      ? Array.from(missingByOption.keys()).map((title) => ({
          option_id: optsByTitle.get(title)!.id,
          original_values: originalSnapshot.get(title) ?? [],
        }))
      : null;

    return new StepResponse({ added_values: added }, compensation);
  },
  async (compensation, { container }) => {
    if (!compensation) return;
    const productModule = container.resolve(
      Modules.PRODUCT
    ) as IProductModuleService;
    for (const c of compensation as Array<{
      option_id: string;
      original_values: string[];
    }>) {
      await productModule.updateProductOptions(c.option_id, {
        values: c.original_values,
      } as any);
    }
  }
);
