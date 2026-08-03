import type { MedusaContainer } from "@medusajs/framework/types";
import { Client } from "pg";

import {
  maybeCompleteOrder,
  type CompletionAttemptSource,
  type MaybeCompleteResult,
} from "../maybe-complete-order";

import {
  listEligiblePendingOrders,
  type EligiblePendingOrder,
} from "./eligible-orders";

export interface NativeCompletionReconcilerOptions {
  source?: CompletionAttemptSource;
  minAgeSeconds?: number;
  limit?: number;
  orderIds?: string[];
  dryRun?: boolean;
}

export interface NativeCompletionReconcilerResult {
  candidates: EligiblePendingOrder[];
  results: Array<{ order: EligiblePendingOrder; result: MaybeCompleteResult }>;
  completed: number;
}

/**
 * Durable backstop for a lost event/request edge. It never writes quantities or
 * status directly: every candidate is revalidated and completed by the shared
 * advisory-locked helper.
 */
export async function reconcileNativeOrderCompletions(
  container: MedusaContainer,
  options: NativeCompletionReconcilerOptions = {}
): Promise<NativeCompletionReconcilerResult> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  let candidates: EligiblePendingOrder[] = [];
  try {
    candidates = await listEligiblePendingOrders(db, {
      minAgeSeconds: options.minAgeSeconds ?? 90,
      limit: options.limit ?? 100,
      orderIds: options.orderIds,
    });
  } finally {
    await db.end();
  }

  const results: NativeCompletionReconcilerResult["results"] = [];
  if (!options.dryRun) {
    for (const order of candidates) {
      const result = await maybeCompleteOrder(container, order.id, {
        source: options.source ?? "scheduled_reconciler",
      });
      results.push({ order, result });
    }
  }

  return {
    candidates,
    results,
    completed: results.filter((entry) => entry.result.completed).length,
  };
}
