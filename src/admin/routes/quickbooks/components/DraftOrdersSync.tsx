import { useState, useEffect } from "react";
import { Container, Heading, Text, Button, Badge, toast } from "@medusajs/ui";

interface DraftOrder {
  id: string;
  display_id: number;
  status: string;
  customer?: { first_name?: string; last_name?: string; email?: string };
  metadata?: Record<string, any>;
  items?: Array<{ title: string; quantity: number }>;
  created_at: string;
}

interface SyncResult {
  success: boolean;
  qbEstimateTxnId?: string;
  qbEstimateRef?: string;
  message?: string;
  error?: string;
}

/**
 * DraftOrdersSync
 *
 * Section within the QuickBooks admin panel that shows draft orders
 * pending QB sync and allows manual sync per order.
 *
 * This component is the primary UI for QB Estimate sync since
 * the /draft-orders/:id route in Medusa v2 does not support widget injection.
 */
export const DraftOrdersSync = () => {
  const [orders, setOrders] = useState<DraftOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [synced, setSynced] = useState<Record<string, SyncResult>>({});

  const fetchDraftOrders = async () => {
    setLoading(true);
    try {
      // Fetch orders with status=draft
      const resp = await fetch(
        "/admin/orders?status[]=draft&limit=50&fields=id,display_id,status,metadata,customer.*,items.*,created_at",
        { credentials: "include" }
      );
      const json = await resp.json();
      const allDrafts: DraftOrder[] = json.orders || [];
      // Filter only those not yet synced to QB
      const unsynced = allDrafts.filter((o) => !o.metadata?.qb_estimate_txn_id);
      setOrders(unsynced);
    } catch (err) {
      console.error("Failed to fetch draft orders", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDraftOrders();
  }, []);

  const handleSync = async (orderId: string, displayId: number) => {
    setSyncing((prev) => ({ ...prev, [orderId]: true }));
    try {
      const resp = await fetch("/admin/quickbooks/draft-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ orderId }),
      });
      const json: SyncResult = await resp.json();
      setSynced((prev) => ({ ...prev, [orderId]: json }));

      if (json.success) {
        toast.success(
          json.message || `Draft Order #${displayId} synced to QB!`
        );
        // Remove from pending list
        setOrders((prev) => prev.filter((o) => o.id !== orderId));
      } else {
        toast.error(json.error || "Sync failed");
      }
    } catch (err: any) {
      toast.error(err.message || "Network error");
    } finally {
      setSyncing((prev) => ({ ...prev, [orderId]: false }));
    }
  };

  return (
    <Container className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Heading level="h2">Draft Orders → QB Estimates</Heading>
          {!loading && (
            <Badge color={orders.length > 0 ? "orange" : "green"} size="small">
              {orders.length > 0 ? `${orders.length} pending` : "All synced"}
            </Badge>
          )}
        </div>
        <Button
          variant="secondary"
          size="small"
          onClick={fetchDraftOrders}
          isLoading={loading}
        >
          Refresh
        </Button>
      </div>

      {loading && (
        <Text size="small" className="text-ui-fg-muted">
          Loading draft orders...
        </Text>
      )}

      {!loading && orders.length === 0 && (
        <div className="p-4 bg-ui-bg-subtle rounded-md">
          <Text size="small" className="text-ui-fg-subtle">
            ✅ All draft orders are synced to QuickBooks.
          </Text>
        </div>
      )}

      {!loading && orders.length > 0 && (
        <div className="space-y-3">
          {orders.map((order) => {
            const customerName = order.customer
              ? `${order.customer.first_name || ""} ${order.customer.last_name || ""}`.trim() ||
                order.customer.email ||
                "Unknown"
              : "No customer";
            const date = new Date(order.created_at).toLocaleDateString(
              "en-US",
              {
                month: "short",
                day: "numeric",
                year: "numeric",
              }
            );
            const isSyncing = syncing[order.id];
            const result = synced[order.id];

            return (
              <div
                key={order.id}
                className="flex items-center justify-between p-4 bg-ui-bg-base border border-ui-border-base rounded-md"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Text size="small" weight="plus">
                      Draft Order #{order.display_id}
                    </Text>
                    <Badge color="grey" size="small">
                      {order.status}
                    </Badge>
                  </div>
                  <Text size="xsmall" className="text-ui-fg-muted">
                    {customerName} · {date}
                  </Text>
                  {result?.success && (
                    <Text size="xsmall" className="text-ui-fg-subtle mt-1">
                      ✅ QB Estimate:{" "}
                      {result.qbEstimateRef || result.qbEstimateTxnId}
                    </Text>
                  )}
                  {result && !result.success && (
                    <Text size="xsmall" className="text-ui-fg-error mt-1">
                      ❌ {result.error}
                    </Text>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() =>
                      window.open(`/app/draft-orders/${order.id}`, "_blank")
                    }
                  >
                    View
                  </Button>
                  <Button
                    variant="primary"
                    size="small"
                    onClick={() => handleSync(order.id, order.display_id)}
                    isLoading={isSyncing}
                    disabled={isSyncing}
                  >
                    Save to QB
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-4 p-3 bg-ui-bg-subtle rounded-md">
        <Text size="xsmall" className="text-ui-fg-muted">
          💡 "Save to QB" creates a QuickBooks Estimate from the draft order.
          When the draft is converted to an order, the estimate will be
          converted to a Sales Order automatically.
        </Text>
      </div>
    </Container>
  );
};
