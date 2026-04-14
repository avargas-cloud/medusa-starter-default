import { useState, useCallback, useRef, useEffect } from "react";
import { EstimateStatus, DraftOrderDetail, TimelineEvent } from "../types";

/** Owns order fetch, thumbnail enrichment, timeline, and current-user resolution. */
export const useOrderFetch = (
  id: string | undefined,
  setItemQtys: (q: Record<string, number>) => void,
  setItemPrices: (p: Record<string, string>) => void,
  setEstimateStatus: (s: EstimateStatus | "") => void
) => {
  const [order, setOrder] = useState<DraftOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [currentUser, setCurrentUser] = useState("");
  const localEventsRef = useRef<TimelineEvent[]>([]);
  const [localTick, setLocalTick] = useState(0);

  const fetchOrder = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setFetchError(null);
    try {
      const [oRes, dRes] = await Promise.all([
        fetch(
          `/admin/orders/${id}?fields=+customer.*,+customer.groups,+shipping_address.*,+billing_address.*,+items.*,+items.adjustments.*,+items.variant.*,+shipping_methods.*,*promotions,*promotions.application_method,+metadata,+currency_code,+email,+created_at,+display_id,+status,+sales_channel.*,+region.*`,
          { credentials: "include" }
        ),
        fetch(`/admin/draft-orders/${id}`, { credentials: "include" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (!oRes.ok) throw new Error(`HTTP ${oRes.status}`);
      const json = await oRes.json();
      const rawOrder = json.order;
      const preview = dRes?.order ?? dRes?.draft_order ?? null;
      const normalizePrice = (cents: number) =>
        cents > 100 ? cents / 100 : cents;
      const normalizedPreviewItems = preview?.items
        ? (preview.items as any[]).map((i: any) => ({
            ...i,
            unit_price: normalizePrice(i.unit_price ?? 0),
          }))
        : null;
      const merged = {
        ...rawOrder,
        items: normalizedPreviewItems ?? rawOrder.items ?? [],
        subtotal:
          preview?.subtotal != null
            ? preview.subtotal / 100
            : (rawOrder.subtotal ?? 0),
        shipping_total:
          preview?.shipping_total != null
            ? preview.shipping_total / 100
            : (rawOrder.shipping_total ?? 0),
        // Compute pre-tax discount from raw item adjustment amounts.
        // Medusa's order.discount_total grosses-up by (1 + tax_rate) for its own display,
        // giving $4.93 instead of the correct pre-tax $4.61. We use item.adjustments[].amount
        // which is the actual amount stored in order_line_item_adjustment.amount.
        discount_total: (() => {
          const fromAdj = (rawOrder.items ?? []).reduce(
            (s: number, item: any) =>
              s +
              (item.adjustments ?? []).reduce(
                (a: number, adj: any) => a + (Number(adj.amount) || 0),
                0
              ),
            0
          );
          if (fromAdj > 0) return fromAdj;
          return preview?.discount_total != null
            ? preview.discount_total / 100
            : (rawOrder.discount_total ?? 0);
        })(),
        tax_total:
          preview?.tax_total != null
            ? preview.tax_total / 100
            : (rawOrder.tax_total ?? 0),
        total:
          preview?.total != null ? preview.total / 100 : (rawOrder.total ?? 0),
      };
      if (merged.items)
        merged.items = merged.items.filter((item: any) => item.quantity > 0);
      setOrder(merged);

      // Enrich customer with full data (groups + metadata) — order API may not expand all customer fields
      const customerId: string | undefined =
        rawOrder.customer_id ?? rawOrder.customer?.id;
      if (customerId) {
        try {
          const custRes = await fetch(
            `/admin/customers/${customerId}?fields=*groups,metadata,first_name,last_name,email`,
            { credentials: "include" }
          );
          if (custRes.ok) {
            const { customer: fullCust } = await custRes.json();
            if (fullCust) {
              merged.customer = { ...(merged.customer ?? {}), ...fullCust };
              setOrder({ ...merged });
            }
          }
        } catch {
          /* best-effort */
        }
      }

      // Enrich items with thumbnail from product
      try {
        const rawItems: any[] = merged.items ?? [];
        const variantIds = [
          ...new Set<string>(
            rawItems
              .map((i: any) => i.variant_id ?? i.variant?.id)
              .filter(Boolean)
          ),
        ];
        if (variantIds.length > 0) {
          const vRes = await fetch(
            `/admin/product-variants?${variantIds.map((vid) => `id[]=${vid}`).join("&")}&limit=50`,
            { credentials: "include" }
          );
          if (vRes.ok) {
            const { variants: vList } = await vRes.json();
            const productIds = [
              ...new Set<string>(
                (vList ?? []).map((v: any) => v.product_id).filter(Boolean)
              ),
            ];
            const variantProductMap: Record<string, string> = {};
            (vList ?? []).forEach((v: any) => {
              if (v.product_id) variantProductMap[v.id] = v.product_id;
            });
            if (productIds.length > 0) {
              const pRes = await fetch(
                `/admin/products?${productIds.map((pid) => `id[]=${pid}`).join("&")}&limit=50`,
                { credentials: "include" }
              );
              if (pRes.ok) {
                const { products } = await pRes.json();
                const prodMap: Record<string, any> = {};
                (products ?? []).forEach((p: any) => {
                  prodMap[p.id] = p;
                });
                merged.items = rawItems.map((item: any) => {
                  const rawVid: string | undefined =
                    item.variant_id ?? item.variant?.id;
                  const productId: string | undefined =
                    rawVid != null ? variantProductMap[rawVid] : undefined;
                  const prod =
                    productId != null ? prodMap[productId] : undefined;
                  return {
                    ...item,
                    thumbnail: item.thumbnail ?? prod?.thumbnail,
                    title: prod?.title ?? item.title,
                  };
                });
                setOrder({ ...merged });
              }
            }
          }
        }
      } catch {
        /* thumbnail enrichment best-effort */
      }

      // Init per-item qty/price state
      const qtys: Record<string, number> = {};
      const prices: Record<string, string> = {};
      for (const item of merged.items ?? []) {
        qtys[item.id] = item.quantity;
        prices[item.id] = String(item.unit_price ?? 0);
      }
      setItemQtys(qtys);
      setItemPrices(prices);

      const es = (merged?.metadata?.order_status ??
        merged?.metadata?.estimate_status) as EstimateStatus | undefined;
      setEstimateStatus(es ?? "Created");
      if (!es)
        fetch(`/admin/draft-orders/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ metadata: { order_status: "Created" } }),
        }).catch(() => {});

      // Fetch timeline from order changes
      try {
        const chRes = await fetch(`/admin/orders/${id}/changes`, {
          credentials: "include",
        });
        const userCache: Record<string, string> = {};
        const resolveUser = async (
          userId?: string
        ): Promise<string | undefined> => {
          if (!userId) return undefined;
          if (userCache[userId]) return userCache[userId];
          try {
            const ur = await fetch(`/admin/users/${userId}`, {
              credentials: "include",
            });
            if (ur.ok) {
              const { user: u } = await ur.json();
              const name =
                `${u?.first_name ?? ""} ${u?.last_name ?? ""}`.trim() ||
                u?.email ||
                userId;
              userCache[userId] = name;
              return name;
            }
          } catch {}
          return undefined;
        };
        const events: TimelineEvent[] = [
          {
            id: merged.id + "-created",
            created_at: merged.created_at,
            title: "Created",
            description: "Draft order created",
          },
        ];
        if (chRes.ok) {
          const { order_changes } = await chRes.json();
          for (const ch of order_changes ?? []) {
            const actions: any[] = ch.actions ?? [];
            const itemAdds = actions.filter((a) =>
              /item_add|add_item/i.test(a.action ?? a.action_type ?? "")
            ).length;
            const itemRems = actions.filter((a) =>
              /item_delete|item_remove|remove_item/i.test(
                a.action ?? a.action_type ?? ""
              )
            ).length;
            const itemAmends = actions.filter((a) =>
              /item_amend|item_update|amend_item/i.test(
                a.action ?? a.action_type ?? ""
              )
            ).length;
            const shippingAdds = actions.filter((a) =>
              /shipping_add|add_shipping/i.test(a.action ?? a.action_type ?? "")
            ).length;
            const parts: string[] = [];
            if (itemAdds > 0)
              parts.push(`Added ${itemAdds} item${itemAdds > 1 ? "s" : ""}`);
            if (itemRems > 0)
              parts.push(`Removed ${itemRems} item${itemRems > 1 ? "s" : ""}`);
            if (itemAmends > 0)
              parts.push(
                `Updated ${itemAmends} item${itemAmends > 1 ? "s" : ""}`
              );
            if (shippingAdds > 0) parts.push("Added shipping method");
            if (parts.length === 0 && actions.length > 0)
              parts.push(
                `${actions.length} change${actions.length > 1 ? "s" : ""}`
              );
            let title = "Order edited";
            if (
              shippingAdds > 0 &&
              itemAdds === 0 &&
              itemRems === 0 &&
              itemAmends === 0
            )
              title = "Shipping methods added";
            else if (itemAdds > 0 && shippingAdds === 0 && itemRems === 0)
              title = "Items added";
            else if (itemRems > 0 && itemAdds === 0 && shippingAdds === 0)
              title = "Items removed";
            else if (
              itemAmends > 0 &&
              itemAdds === 0 &&
              shippingAdds === 0 &&
              itemRems === 0
            )
              title = "Items updated";
            if (ch.status === "pending") title += " (pending)";
            if (parts.length > 0 || ch.status === "confirmed") {
              const eventUser = (await resolveUser(ch.created_by)) ?? undefined;
              events.push({
                id: ch.id,
                created_at: ch.created_at,
                title,
                description: parts.join(" · ") || undefined,
                user: eventUser,
              });
            }
          }
        }
        const sentAt = merged?.metadata?.estimate_sent_at as string | undefined;
        const sentTo = merged?.metadata?.estimate_sent_to as string | undefined;
        const sentBy = merged?.metadata?.estimate_sent_by as string | undefined;
        if (sentAt)
          events.push({
            id: `email-sent-${sentAt}`,
            created_at: sentAt,
            title: "Email Sent",
            description: sentTo
              ? `Estimate emailed to ${sentTo}`
              : "Estimate emailed to customer",
            user: sentBy || undefined,
          });
        setTimeline(
          events.sort(
            (a, b) =>
              new Date(b.created_at).getTime() -
              new Date(a.created_at).getTime()
          )
        );
      } catch {
        setTimeline([
          {
            id: merged.id,
            created_at: merged.created_at,
            title: "Created",
            description: "Draft order created",
          },
        ]);
      }
    } catch (e: any) {
      setFetchError(e.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  useEffect(() => {
    fetch("/admin/users/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const u = data?.user;
        if (u)
          setCurrentUser(
            `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || u.email || ""
          );
      })
      .catch(() => {});
  }, []);

  const addTimelineEvent = useCallback(
    (title: string, description?: string, user?: string) => {
      const event: TimelineEvent = {
        id: `local-${Date.now()}`,
        title,
        description,
        created_at: new Date().toISOString(),
        user,
      };
      localEventsRef.current = [event, ...localEventsRef.current];
      setLocalTick((t) => t + 1);
    },
    []
  );

  const mergedTimeline = (
    localTick >= 0 ? [...localEventsRef.current, ...timeline] : timeline
  ).sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return {
    order,
    setOrder,
    loading,
    fetchError,
    fetchOrder,
    timeline: mergedTimeline,
    currentUser,
    addTimelineEvent,
  };
};
