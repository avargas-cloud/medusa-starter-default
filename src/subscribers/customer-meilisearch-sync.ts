import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { syncCustomerToMeili } from "../lib/meilisearch/sync-customer";

/**
 * AUTO-SYNC CUSTOMER TO MEILISEARCH
 *
 * Subscribes to every event that can change a customer's MeiliSearch
 * document in the `customers` index:
 *
 *   1. customer.created / customer.updated  → upsert fresh doc
 *   2. customer.deleted                      → deleteDocument
 *   3. Group membership changes              → upsert fresh doc (so the
 *      derived `price_level` field stays in sync with the Wholesale group)
 *
 * Group membership events are tricky. Medusa v2 does not expose a single
 * documented event for customer↔group attach/detach; the runtime name can
 * vary by core-flow version. We subscribe to every plausible name and
 * defensively resolve the affected customer_id(s) from the event payload,
 * which may contain `customer_id`, `id` (of the link row), `data`, etc.
 */

type LinkEventData = {
  id?: string | string[];
  customer_id?: string | string[];
  customer_group_id?: string;
  source?: { id?: string; customer_id?: string };
  target?: { id?: string; customer_id?: string };
  data?:
    | { customer_id?: string; id?: string }
    | Array<{ customer_id?: string; id?: string }>;
};

function extractCustomerIdsFromLinkEvent(
  data: LinkEventData | undefined | null
): string[] {
  if (!data) return [];
  const ids = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === "string" && v) ids.add(v);
  };
  const pushMany = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(push);
    else push(v);
  };
  pushMany(data.customer_id);
  pushMany(data.source?.customer_id);
  pushMany(data.target?.customer_id);
  if (data.data) {
    const rows = Array.isArray(data.data) ? data.data : [data.data];
    for (const row of rows) pushMany(row?.customer_id);
  }
  return [...ids];
}

async function resolveCustomerIdsFromLinkRowIds(
  linkRowIds: string[],
  container: any,
  logger: any
): Promise<string[]> {
  if (linkRowIds.length === 0) return [];
  try {
    const query = container.resolve("query");
    const { data } = await query.graph({
      entity: "customer_group_customer",
      fields: ["customer_id"],
      filters: { id: linkRowIds },
      // Include soft-deleted rows so detached links still resolve to a
      // customer id we can re-sync.
      withDeleted: true,
    });
    return (data ?? [])
      .map((r: any) => r?.customer_id)
      .filter((id: unknown): id is string => typeof id === "string" && !!id);
  } catch (err: any) {
    logger.warn(
      `[MEILI-CUSTOMER-SYNC] resolveCustomerIdsFromLinkRowIds failed: ${err.message}`
    );
    return [];
  }
}

async function deleteCustomerDoc(customerId: string, logger: any) {
  try {
    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });
    await client.index("customers").deleteDocument(customerId);
    logger.info(
      `[MEILI-CUSTOMER-SYNC] 🗑️  Deleted customer doc: ${customerId}`
    );
  } catch (err: any) {
    logger.warn(
      `[MEILI-CUSTOMER-SYNC] ⚠️ Meili delete failed for ${customerId}: ${err.message}`
    );
  }
}

export default async function customerMeilisearchSubscriber({
  event,
  container,
}: SubscriberArgs<any>) {
  const logger = container.resolve("logger");

  const isGroupLinkEvent =
    event.name === "link.created" ||
    event.name === "link.deleted" ||
    event.name.endsWith("customer-group-customer.created") ||
    event.name.endsWith("customer-group-customer.deleted") ||
    event.name.endsWith("customer-group-customer.attached") ||
    event.name.endsWith("customer-group-customer.detached");

  // ── Direct customer lifecycle ─────────────────────────────────────────
  if (event.name === "customer.deleted") {
    const id = event.data?.id;
    if (typeof id === "string") {
      await deleteCustomerDoc(id, logger);
    } else if (Array.isArray(id)) {
      for (const one of id) {
        if (typeof one === "string") await deleteCustomerDoc(one, logger);
      }
    }
    return;
  }

  if (event.name === "customer.created" || event.name === "customer.updated") {
    const id = event.data?.id;
    if (typeof id === "string") {
      await syncCustomerToMeili(id, container, logger);
    } else if (Array.isArray(id)) {
      for (const one of id) {
        if (typeof one === "string") await syncCustomerToMeili(one, container, logger);
      }
    }
    return;
  }

  // ── Group membership changes ──────────────────────────────────────────
  if (isGroupLinkEvent) {
    const data = event.data as LinkEventData;
    let customerIds = extractCustomerIdsFromLinkEvent(data);

    // Some link-module events only carry the link row id — resolve that
    // back to the customer via the join table.
    if (customerIds.length === 0 && data?.id) {
      const linkIds = Array.isArray(data.id) ? data.id : [data.id];
      customerIds = await resolveCustomerIdsFromLinkRowIds(
        linkIds,
        container,
        logger
      );
    }

    if (customerIds.length === 0) {
      logger.warn(
        `[MEILI-CUSTOMER-SYNC] Could not extract customer_id from ${event.name} payload; skipping`
      );
      return;
    }

    for (const cid of customerIds) {
      await syncCustomerToMeili(cid, container, logger);
    }
    return;
  }

  // Fallthrough — unknown event name for this subscriber.
  logger.warn(
    `[MEILI-CUSTOMER-SYNC] Unhandled event: ${event.name} — ignoring`
  );
}

export const config: SubscriberConfig = {
  event: [
    "customer.created",
    "customer.updated",
    "customer.deleted",
    // Group membership events — Medusa v2 emits at least one of these
    // depending on the code path. We subscribe to all plausible names and
    // resolve the customer_id defensively.
    "customer.customer-group-customer.created",
    "customer.customer-group-customer.deleted",
    "customer-group-customer.created",
    "customer-group-customer.deleted",
    "customer-group-customer.attached",
    "customer-group-customer.detached",
    "link.created",
    "link.deleted",
  ],
};
