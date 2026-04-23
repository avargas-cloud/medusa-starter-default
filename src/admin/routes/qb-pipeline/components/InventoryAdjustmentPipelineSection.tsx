import { ArrowPath } from "@medusajs/icons";
import {
  Badge,
  Button,
  Container,
  Input,
  Select,
  Table,
  Text,
  Tooltip,
  toast,
} from "@medusajs/ui";
import { useEffect, useMemo, useState } from "react";

type AddStatus = "waiting" | "processing" | "synced" | "error";
type VoidStatus = null | "waiting" | "processing" | "voided" | "error";

interface PipelineRow {
  id: string;
  seq: number;
  status: AddStatus;
  void_status: VoidStatus;
  count_id: string;
  count_number: string | null;
  count_memo: string | null;
  qb_account_list_id: string;
  qb_txn_number: string | null;
  qb_list_id: string | null;
  retries: number;
  void_retries: number;
  last_error: string | null;
  void_last_error: string | null;
  synced_at: string | null;
  void_synced_at: string | null;
  lines_count: number;
  total_delta_units: number;
  created_at: string;
  updated_at: string;
}

const STATUS_FILTERS = [
  { label: "All", value: "__all__" },
  { label: "Waiting", value: "waiting" },
  { label: "Processing", value: "processing" },
  { label: "Synced", value: "synced" },
  { label: "Error", value: "error" },
];

const StatusBadge = ({ status }: { status: AddStatus }) => {
  if (status === "synced") return <Badge color="green" size="2xsmall">synced</Badge>;
  if (status === "error") return <Badge color="red" size="2xsmall">error</Badge>;
  if (status === "processing") return <Badge color="blue" size="2xsmall">processing</Badge>;
  return <Badge color="orange" size="2xsmall">waiting</Badge>;
};

const VoidStatusBadge = ({ status }: { status: VoidStatus }) => {
  if (!status) return <span className="text-ui-fg-muted text-xs">—</span>;
  if (status === "voided") return <Badge color="purple" size="2xsmall">voided</Badge>;
  if (status === "error") return <Badge color="red" size="2xsmall">void-err</Badge>;
  if (status === "processing") return <Badge color="blue" size="2xsmall">voiding</Badge>;
  return <Badge color="orange" size="2xsmall">void-pending</Badge>;
};

const truncate = (s: string | null, n = 16): string => {
  if (!s) return "—";
  return s.length <= n ? s : `${s.slice(0, n)}…`;
};

const fmt = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : "—";

export const InventoryAdjustmentPipelineSection = () => {
  const [rows, setRows] = useState<PipelineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("__all__");
  const [search, setSearch] = useState("");
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  const fetchRows = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status !== "__all__") params.set("status", status);
      params.set("limit", "200");
      const res = await fetch(
        `/admin/qb-catalog/inventory-adjustment-pipeline?${params}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { rows: PipelineRow[] };
      setRows(data.rows ?? []);
    } catch (e) {
      toast.error("Failed to load inventory adjustment pipeline", {
        description: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    const interval = setInterval(fetchRows, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) =>
      [
        r.count_number,
        r.qb_txn_number,
        r.qb_list_id,
        r.last_error,
        r.void_last_error,
        r.count_memo,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(s)
    );
  }, [rows, search]);

  const counts = useMemo(() => {
    const c = { waiting: 0, processing: 0, synced: 0, error: 0, void: 0 };
    for (const r of rows) {
      if (r.status === "waiting") c.waiting++;
      else if (r.status === "processing") c.processing++;
      else if (r.status === "synced") c.synced++;
      else if (r.status === "error") c.error++;
      if (r.void_status) c.void++;
    }
    return c;
  }, [rows]);

  const retry = async (row: PipelineRow) => {
    setRetrying((prev) => new Set(prev).add(row.id));
    try {
      const res = await fetch(
        `/admin/qb-catalog/inventory-adjustment-pipeline/${row.id}/retry`,
        { method: "POST", credentials: "include" }
      );
      const data = (await res.json()) as {
        ok?: boolean;
        retried_phase?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Retry failed");
      toast.success("Re-queued", {
        description: `Reset ${data.retried_phase} phase to waiting.`,
      });
      fetchRows();
    } catch (e) {
      toast.error("Retry failed", { description: (e as Error).message });
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3">
        <Badge color="orange" size="small">Waiting: {counts.waiting}</Badge>
        <Badge color="blue" size="small">Processing: {counts.processing}</Badge>
        <Badge color="green" size="small">Synced: {counts.synced}</Badge>
        <Badge color="red" size="small">Error: {counts.error}</Badge>
        <Badge color="purple" size="small">Void: {counts.void}</Badge>
      </div>

      <Container className="p-0">
        <div className="flex items-center gap-3 px-6 py-3 border-b border-ui-border-base">
          <Select value={status} onValueChange={setStatus}>
            <Select.Trigger className="max-w-xs">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {STATUS_FILTERS.map((f) => (
                <Select.Item key={f.value} value={f.value}>
                  {f.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
          <Input
            placeholder="Search count # / RefNumber / TxnID / error…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
          <Button variant="secondary" onClick={fetchRows} isLoading={loading}>
            <ArrowPath /> Refresh
          </Button>
          <Text className="text-ui-fg-subtle text-sm ml-auto">
            {filtered.length} rows
          </Text>
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
                  <Table.HeaderCell>Count</Table.HeaderCell>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                  <Table.HeaderCell>Void</Table.HeaderCell>
                  <Table.HeaderCell>RefNumber</Table.HeaderCell>
                  <Table.HeaderCell>TxnID</Table.HeaderCell>
                  <Table.HeaderCell>Lines</Table.HeaderCell>
                  <Table.HeaderCell>Δ Units</Table.HeaderCell>
                  <Table.HeaderCell>Retries</Table.HeaderCell>
                  <Table.HeaderCell>Synced</Table.HeaderCell>
                  <Table.HeaderCell>Error</Table.HeaderCell>
                  <Table.HeaderCell>Actions</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filtered.map((r) => {
                  const error = r.last_error ?? r.void_last_error;
                  const totalRetries = (r.retries ?? 0) + (r.void_retries ?? 0);
                  const canRetry =
                    r.status === "error" || r.void_status === "error";
                  return (
                    <Table.Row key={r.id}>
                      <Table.Cell className="font-mono text-sm text-ui-fg-subtle">
                        #{r.seq}
                      </Table.Cell>
                      <Table.Cell className="font-mono text-sm">
                        {r.count_number ?? truncate(r.count_id, 12)}
                      </Table.Cell>
                      <Table.Cell><StatusBadge status={r.status} /></Table.Cell>
                      <Table.Cell><VoidStatusBadge status={r.void_status} /></Table.Cell>
                      <Table.Cell className="font-mono text-xs">
                        {r.qb_txn_number ?? "—"}
                      </Table.Cell>
                      <Table.Cell className="font-mono text-xs">
                        {r.qb_list_id ? (
                          <Tooltip content={r.qb_list_id}>
                            <span>{truncate(r.qb_list_id, 14)}</span>
                          </Tooltip>
                        ) : "—"}
                      </Table.Cell>
                      <Table.Cell>{r.lines_count}</Table.Cell>
                      <Table.Cell>{r.total_delta_units}</Table.Cell>
                      <Table.Cell>{totalRetries}</Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-xs">
                        {fmt(r.void_synced_at ?? r.synced_at)}
                      </Table.Cell>
                      <Table.Cell className="max-w-xs">
                        {error ? (
                          <Tooltip content={error}>
                            <span className="text-ui-fg-error text-xs truncate block">
                              {error}
                            </span>
                          </Tooltip>
                        ) : "—"}
                      </Table.Cell>
                      <Table.Cell>
                        {canRetry && (
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
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        )}
      </Container>
    </div>
  );
};
