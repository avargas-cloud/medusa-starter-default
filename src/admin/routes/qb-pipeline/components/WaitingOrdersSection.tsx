import { ArrowPath } from "@medusajs/icons";
import {
  Badge,
  Button,
  Container,
  FocusModal,
  Heading,
  Input,
  Label,
  Table,
  Text,
  Tooltip,
  toast,
} from "@medusajs/ui";
import { useEffect, useState } from "react";

type WaitingVariant = {
  id: string;
  sku: string | null;
  title: string | null;
  has_qb_id: boolean;
};

type WaitingInvoice = {
  id: string;
  invoice_number: number | null;
  order_id: string;
  total: number;
  created_at: string;
  waiting_variant_ids: string[];
  waiting_variants: WaitingVariant[];
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "—";

const fmtMoney = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export const WaitingOrdersSection = () => {
  const [invoices, setInvoices] = useState<WaitingInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [markModal, setMarkModal] = useState<{
    invoiceId: string;
    variant: WaitingVariant;
  } | null>(null);
  const [markListId, setMarkListId] = useState("");
  const [markEditSeq, setMarkEditSeq] = useState("");
  const [marking, setMarking] = useState(false);

  const fetchInvoices = async () => {
    setLoading(true);
    try {
      const res = await fetch("/admin/qb-catalog/waiting-invoices", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setInvoices(data.invoices ?? []);
    } catch (e) {
      toast.error("Failed to load waiting invoices", {
        description: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInvoices();
    const interval = setInterval(fetchInvoices, 15000);
    return () => clearInterval(interval);
  }, []);

  const submitMark = async () => {
    if (!markModal || !markListId.trim()) return;
    setMarking(true);
    try {
      const res = await fetch(
        `/admin/qb-catalog/waiting-invoices/${markModal.invoiceId}/mark-manual`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            variant_id: markModal.variant.id,
            qb_list_id: markListId.trim(),
            qb_edit_sequence: markEditSeq.trim() || undefined,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error ?? "Request failed");
      toast.success("Variant marked synced", {
        description: data.message,
      });
      setMarkModal(null);
      setMarkListId("");
      setMarkEditSeq("");
      fetchInvoices();
    } catch (e) {
      toast.error("Mark failed", { description: (e as Error).message });
    } finally {
      setMarking(false);
    }
  };

  return (
    <>
      <Container>
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <Heading level="h3" className="text-sm font-medium flex items-center gap-2">
                ⏳ Waiting Orders
                {invoices.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-normal text-orange-600 animate-pulse">
                    <span className="w-1.5 h-1.5 rounded-full bg-orange-500 inline-block" />
                    Live
                  </span>
                )}
              </Heading>
              <Text className="text-xs text-ui-fg-subtle mt-0.5">
                Invoices held until all variants have a QuickBooks ListID — auto-refreshes every 15 s
              </Text>
            </div>
            <Button variant="secondary" size="small" onClick={fetchInvoices} isLoading={loading}>
              <ArrowPath className="mr-1" /> Refresh
            </Button>
          </div>

          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {invoices.length > 0 && <Badge color="orange" size="xsmall">Waiting {invoices.length}</Badge>}
            {invoices.length === 0 && !loading && (
              <span className="text-xs text-ui-fg-muted">No invoices waiting — all clear 🎉</span>
            )}
          </div>

          <div className="flex items-center mb-3">
            <span className="text-xs text-ui-fg-muted ml-auto">
              {invoices.length} total invoice{invoices.length !== 1 ? "s" : ""} waiting
            </span>
          </div>

          {loading && invoices.length === 0 && (
            <Text className="text-ui-fg-subtle py-6 text-center">Loading…</Text>
          )}
          {!loading && invoices.length === 0 && (
            <Text className="text-ui-fg-subtle py-6 text-center">
              No invoices waiting for item sync. 🎉
            </Text>
          )}
          {invoices.length > 0 && (
            <div className="max-h-[calc(100vh-380px)] overflow-y-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Invoice</Table.HeaderCell>
                    <Table.HeaderCell>Order</Table.HeaderCell>
                    <Table.HeaderCell>Total</Table.HeaderCell>
                    <Table.HeaderCell>Created</Table.HeaderCell>
                    <Table.HeaderCell>Waiting variants</Table.HeaderCell>
                    <Table.HeaderCell>Actions</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {invoices.map((inv) => (
                    <Table.Row key={inv.id}>
                      <Table.Cell className="font-mono text-xs">
                        {inv.invoice_number
                          ? `INV-${inv.invoice_number}`
                          : inv.id.slice(0, 10)}
                      </Table.Cell>
                      <Table.Cell className="font-mono text-xs">
                        <Tooltip content={inv.order_id}>
                          <span>{inv.order_id.slice(0, 10)}…</span>
                        </Tooltip>
                      </Table.Cell>
                      <Table.Cell>{fmtMoney(inv.total)}</Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-xs">
                        {fmtDate(inv.created_at)}
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex flex-col gap-1 max-w-md">
                          {inv.waiting_variants.map((v) => (
                            <div
                              key={v.id}
                              className="flex items-center gap-2 text-xs"
                            >
                              {v.has_qb_id ? (
                                <Badge color="green" size="2xsmall">
                                  ready
                                </Badge>
                              ) : (
                                <Badge color="orange" size="2xsmall">
                                  waiting
                                </Badge>
                              )}
                              <span className="font-mono">{v.sku ?? v.id}</span>
                              {v.title && (
                                <span className="text-ui-fg-subtle truncate">
                                  {v.title}
                                </span>
                              )}
                              {!v.has_qb_id && (
                                <Button
                                  size="small"
                                  variant="secondary"
                                  onClick={() => {
                                    setMarkModal({
                                      invoiceId: inv.id,
                                      variant: v,
                                    });
                                    setMarkListId("");
                                    setMarkEditSeq("");
                                  }}
                                >
                                  Mark manual
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <Text className="text-ui-fg-subtle text-xs">
                          {inv.waiting_variants.every((v) => v.has_qb_id)
                            ? "All synced — promoting next tick"
                            : `${
                                inv.waiting_variants.filter((v) => !v.has_qb_id)
                                  .length
                              } pending`}
                        </Text>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}
        </div>
      </Container>

      <FocusModal
        open={!!markModal}
        onOpenChange={(open) => {
          if (!open) setMarkModal(null);
        }}
      >
        <FocusModal.Content>
          <FocusModal.Header>
            <Heading level="h2">Mark variant manually synced</Heading>
          </FocusModal.Header>
          <FocusModal.Body className="flex flex-col gap-4 p-6 max-w-xl">
            <div>
              <Text className="text-ui-fg-subtle text-sm">
                Use this when the item poller is stuck or the item was created
                directly in QuickBooks Desktop. The invoice gate will promote
                the invoice on the next cron tick (≤2 min).
              </Text>
            </div>
            {markModal && (
              <>
                <div className="rounded-md bg-ui-bg-subtle p-3 text-sm">
                  <div>
                    <strong>SKU:</strong>{" "}
                    <span className="font-mono">
                      {markModal.variant.sku ?? markModal.variant.id}
                    </span>
                  </div>
                  {markModal.variant.title && (
                    <div className="text-ui-fg-subtle">
                      {markModal.variant.title}
                    </div>
                  )}
                </div>
                <div>
                  <Label>QuickBooks ListID *</Label>
                  <Input
                    placeholder="8000XXXX-1776534007"
                    value={markListId}
                    onChange={(e) => setMarkListId(e.target.value)}
                    className="font-mono"
                  />
                </div>
                <div>
                  <Label>EditSequence (optional)</Label>
                  <Input
                    placeholder="1776534007"
                    value={markEditSeq}
                    onChange={(e) => setMarkEditSeq(e.target.value)}
                    className="font-mono"
                  />
                </div>
              </>
            )}
          </FocusModal.Body>
          <FocusModal.Footer>
            <Button variant="secondary" onClick={() => setMarkModal(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitMark}
              disabled={!markListId.trim() || marking}
              isLoading={marking}
            >
              Save ListID
            </Button>
          </FocusModal.Footer>
        </FocusModal.Content>
      </FocusModal>
    </>
  );
};
