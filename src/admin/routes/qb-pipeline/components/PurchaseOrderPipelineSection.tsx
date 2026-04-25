import { ArrowPath } from "@medusajs/icons";
import {
  Badge,
  Button,
  Container,
  Input,
  Select,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import { useEffect, useMemo, useState } from "react";

type PoRow = {
  id: string;
  seq: number | null;
  purchase_order_id: string;
  po_number: string | null;
  draft_number: string | null;
  vendor_name: string | null;
  status: "waiting" | "processing" | "synced" | "error";
  qb_operation_id: string | null;
  qb_list_id: string | null;
  qb_txn_number: string | null;
  last_error: string | null;
  retries: number;
  next_retry_at: string | null;
  synced_at: string | null;
  created_at: string;
};

type Counts = { waiting: number; processing: number; synced: number; error: number };

const STATUS_FILTERS = [
  { label: "All", value: "__all__" },
  { label: "Waiting", value: "waiting" },
  { label: "Processing", value: "processing" },
  { label: "Synced", value: "synced" },
  { label: "Error", value: "error" },
];

const StatusBadge = ({ status }: { status: PoRow["status"] }) => {
  if (status === "synced")   return <Badge color="green"  size="2xsmall">synced</Badge>;
  if (status === "error")    return <Badge color="red"    size="2xsmall">error</Badge>;
  if (status === "processing") return <Badge color="blue" size="2xsmall">processing</Badge>;
  return <Badge color="orange" size="2xsmall">waiting</Badge>;
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export const PurchaseOrderPipelineSection = () => {
  const [rows, setRows]       = useState<PoRow[]>([]);
  const [counts, setCounts]   = useState<Counts>({ waiting: 0, processing: 0, synced: 0, error: 0 });
  const [loading, setLoading] = useState(true);
  const [status, setStatus]   = useState("__all__");
  const [search, setSearch]   = useState("");
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const fetchRows = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status !== "__all__") params.set("status", status);
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/admin/purchase-orders/qb-pipeline?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.rows ?? []);
      setCounts(data.counts ?? { waiting: 0, processing: 0, synced: 0, error: 0 });
    } catch (e) {
      toast.error("Failed to load PO pipeline", { description: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchRows(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(fetchRows, 15000);
    return () => clearInterval(t);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) =>
      [r.po_number, r.draft_number, r.vendor_name, r.qb_list_id, r.qb_txn_number, r.last_error]
        .filter(Boolean).join(" ").toLowerCase().includes(s)
    );
  }, [rows, search]);

  const retry = async (row: PoRow) => {
    setRetrying((prev) => new Set(prev).add(row.id));
    try {
      const res = await fetch(`/admin/purchase-orders/qb-pipeline/${row.id}/retry`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error ?? "Retry failed");
      toast.success("Re-queued", { description: data.message });
      fetchRows();
    } catch (e) {
      toast.error("Retry failed", { description: (e as Error).message });
    } finally {
      setRetrying((prev) => { const next = new Set(prev); next.delete(row.id); return next; });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3">
        <Badge color="orange" size="small">Waiting: {counts.waiting}</Badge>
        <Badge color="blue"   size="small">Processing: {counts.processing}</Badge>
        <Badge color="green"  size="small">Synced: {counts.synced}</Badge>
        <Badge color="red"    size="small">Error: {counts.error}</Badge>
      </div>

      <Container className="p-0">
        <div className="flex items-center gap-3 px-6 py-3 border-b border-ui-border-base">
          <Select value={status} onValueChange={setStatus}>
            <Select.Trigger className="max-w-xs"><Select.Value /></Select.Trigger>
            <Select.Content>
              {STATUS_FILTERS.map((f) => (
                <Select.Item key={f.value} value={f.value}>{f.label}</Select.Item>
              ))}
            </Select.Content>
          </Select>
          <Input
            placeholder="Search PO / vendor / QB ref / error…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
          <Button variant="secondary" onClick={fetchRows} isLoading={loading}>
            <ArrowPath /> Refresh
          </Button>
          <Text className="text-ui-fg-subtle text-sm ml-auto">{filtered.length} rows</Text>
        </div>

        {loading && rows.length === 0 && (
          <Text className="text-ui-fg-subtle py-6 px-6">Loading…</Text>
        )}
        {!loading && filtered.length === 0 && (
          <Text className="text-ui-fg-subtle py-6 px-6">No rows match.</Text>
        )}
        {filtered.length > 0 && (
          <div className="max-h-[calc(100vh-380px)] overflow-y-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>#</Table.HeaderCell>
                  <Table.HeaderCell>PO</Table.HeaderCell>
                  <Table.HeaderCell>Vendor</Table.HeaderCell>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                  <Table.HeaderCell>QB ListID</Table.HeaderCell>
                  <Table.HeaderCell>QB Txn #</Table.HeaderCell>
                  <Table.HeaderCell>Retries</Table.HeaderCell>
                  <Table.HeaderCell>Created</Table.HeaderCell>
                  <Table.HeaderCell>Synced</Table.HeaderCell>
                  <Table.HeaderCell>Error</Table.HeaderCell>
                  <Table.HeaderCell>Actions</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filtered.map((r) => (
                  <>
                    <Table.Row key={r.id}>
                      <Table.Cell className="font-mono text-sm text-ui-fg-subtle">
                        {r.seq != null ? `#${r.seq}` : "—"}
                      </Table.Cell>
                      <Table.Cell className="font-medium text-sm">
                        {r.po_number ?? "—"}
                      </Table.Cell>
                      <Table.Cell className="text-sm">{r.vendor_name ?? "—"}</Table.Cell>
                      <Table.Cell><StatusBadge status={r.status} /></Table.Cell>
                      <Table.Cell className="font-mono text-xs">{r.qb_list_id ?? "—"}</Table.Cell>
                      <Table.Cell className="font-mono text-xs">{r.qb_txn_number ?? "—"}</Table.Cell>
                      <Table.Cell>{r.retries}</Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-xs">{fmt(r.created_at)}</Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-xs">{fmt(r.synced_at)}</Table.Cell>
                      <Table.Cell>
                        {r.last_error ? (
                          <button
                            onClick={() => toggleExpand(r.id)}
                            className="text-xs text-ui-fg-error hover:underline whitespace-nowrap"
                          >
                            {expanded.has(r.id) ? "▲ hide" : "▼ error"}
                          </button>
                        ) : "—"}
                      </Table.Cell>
                      <Table.Cell>
                        {r.status === "error" && (
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => retry(r)}
                            isLoading={retrying.has(r.id)}
                          >
                            <ArrowPath /> Retry
                          </Button>
                        )}
                      </Table.Cell>
                    </Table.Row>
                    {expanded.has(r.id) && r.last_error && (
                      <tr key={`${r.id}-err`} className="bg-red-50/10">
                        <td colSpan={11} className="px-6 py-2">
                          <p className="text-xs text-ui-fg-error font-mono break-words whitespace-pre-wrap">
                            {r.last_error}
                          </p>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </Container>
    </div>
  );
};
