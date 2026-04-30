/**
 * @internal Bridge-ops client surface.
 *
 * As of Section 1.5 (unified pipeline refactor, 2026-04-30), every function
 * exported from this barrel is INTERNAL to the QB pipeline architecture.
 *
 * The contract:
 *   - Subscribers, admin routes, and other handlers MUST NOT call these
 *     functions directly. They should enqueue a `qb_order_pipeline` row
 *     instead and let the consolidator pick it up.
 *   - The ONLY canonical callers are:
 *       1. `qb-pipeline-consolidator.ts` (the cron that processes pipeline rows)
 *       2. Handlers in `lib/quickbooks/handlers/` (which are themselves only
 *          called by the consolidator under the unified architecture)
 *
 * Why: this guarantees a single code path per QB operation. A change to
 * "how we send X to QB" is a change in one place (consolidator + the helper
 * here), not in a subscriber AND a handler AND an admin route.
 *
 * If you need to add a new caller, ask: should this go through the pipeline
 * (enqueue + status='pending')? In nearly all cases the answer is yes.
 */

export * from "./types";
export * from "./core";
export * from "./customers";
export * from "./estimates";
// (inventory.ts removed in 1.5.2 — dead code; QB inventory adjustments go
// exclusively through qb_inventory_adjustment_pipeline + qb-inventory-adjustment-poller)
export * from "./invoices";
export * from "./payments";
export * from "./sales-orders";
export * from "./sales-receipts";
export * from "./transfer";
export * from "./credit-memos";
export * from "./checks";
export * from "./refunds";
