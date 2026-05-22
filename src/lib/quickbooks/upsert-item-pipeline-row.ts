/**
 * Dedup-aware insert for qb_item_pipeline rows.
 *
 * Business rule (operator request, 2026-05-22):
 *   - An `add` must never create more than one OPEN row per variant. Re-editing
 *     an item in inventory while its first add is still waiting/error must fold
 *     onto that single row, not pile up duplicates (SUP-24RGBCCT had 3).
 *   - A `mod` may create a fresh row each time — each edit is a distinct QB
 *     operation against an already-existing item.
 *
 * "Open" = still in flight (waiting | error). `synced` and `failed_permanent`
 * are terminal: a brand-new add after one of those genuinely starts over, so we
 * never reuse them.
 */

export type CatalogPipelineService = {
  listQbItemPipelines: (
    filters: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<Array<{ id: string; created_at?: string | Date }>>;
  createQbItemPipelines: (
    data: Record<string, unknown>
  ) => Promise<{ id: string }>;
  updateQbItemPipelines: (
    data: Record<string, unknown>
  ) => Promise<{ id: string }>;
  softDeleteQbItemPipelines: (ids: string[]) => Promise<unknown>;
};

type MinimalLogger = { info: (m: string) => void; warn: (m: string) => void };

/** Pipeline statuses that still represent an in-flight add. */
const OPEN_STATUSES = ["waiting", "error"] as const;

export type UpsertItemPipelineInput = {
  variant_id: string;
  sku: string;
  op_action: "add" | "mod";
  item_type?: string;
  op_payload?: Record<string, unknown> | null;
  status?: string;
  qb_id?: string | null;
  qb_operation_id?: string | null;
  last_error?: string | null;
};

export type UpsertItemPipelineResult = { id: string; reused: boolean };

/**
 * Insert a qb_item_pipeline row, collapsing duplicate OPEN `add` rows for the
 * same variant onto a single row. `mod` always inserts.
 */
export async function upsertItemPipelineRow(
  catalog: CatalogPipelineService,
  input: UpsertItemPipelineInput,
  logger?: MinimalLogger
): Promise<UpsertItemPipelineResult> {
  // Each mod is its own QB operation — never dedup.
  if (input.op_action !== "add") {
    const row = await catalog.createQbItemPipelines(input);
    return { id: row.id, reused: false };
  }

  let existing: Array<{ id: string; created_at?: string | Date }> = [];
  try {
    existing = await catalog.listQbItemPipelines({
      variant_id: input.variant_id,
      op_action: "add",
      status: OPEN_STATUSES as unknown as string[],
    });
  } catch (e: any) {
    // A lookup failure must not block the add — fall back to a plain insert.
    logger?.warn(
      `[upsertItemPipelineRow] dedup lookup failed for ${input.sku}: ${e.message} — inserting new row`
    );
    const row = await catalog.createQbItemPipelines(input);
    return { id: row.id, reused: false };
  }

  if (!existing || existing.length === 0) {
    const row = await catalog.createQbItemPipelines(input);
    return { id: row.id, reused: false };
  }

  // Reuse the most recent open row; fold any older duplicates into it.
  const sorted = [...existing].sort(
    (a, b) =>
      new Date(b.created_at ?? 0).getTime() -
      new Date(a.created_at ?? 0).getTime()
  );
  const [primary, ...dupes] = sorted;
  if (!primary) {
    const row = await catalog.createQbItemPipelines(input);
    return { id: row.id, reused: false };
  }

  await catalog.updateQbItemPipelines({
    id: primary.id,
    sku: input.sku,
    item_type: input.item_type,
    op_action: "add",
    op_payload: input.op_payload ?? null,
    status: input.status ?? "waiting",
    qb_id: input.qb_id ?? null,
    qb_operation_id: input.qb_operation_id ?? null,
    last_error: input.last_error ?? null,
    retries: 0,
    next_retry_at: null,
    failed_at: null,
  });

  if (dupes.length > 0) {
    await catalog.softDeleteQbItemPipelines(dupes.map((d) => d.id));
    logger?.info(
      `[upsertItemPipelineRow] ${input.sku}: folded ${dupes.length} duplicate add row(s) into ${primary.id}`
    );
  } else {
    logger?.info(
      `[upsertItemPipelineRow] ${input.sku}: reused open add row ${primary.id} (no new duplicate)`
    );
  }

  return { id: primary.id, reused: true };
}
