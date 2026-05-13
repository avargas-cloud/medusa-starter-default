import { ArrowPath } from "@medusajs/icons";
import {
  Badge,
  Button,
  Container,
  Heading,
  Table,
  Text,
  Tooltip,
  toast,
} from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";

import { PAGE_SIZE, PipelinePagination } from "./PipelinePagination";

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
  if (status === "synced")
    return (
      <Badge color="green" size="2xsmall">
        synced
      </Badge>
    );
  if (status === "error")
    return (
      <Badge color="red" size="2xsmall">
        error
      </Badge>
    );
  if (status === "processing")
    return (
      <Badge color="blue" size="2xsmall">
        processing
      </Badge>
    );
  return (
    <Badge color="orange" size="2xsmall">
      waiting
    </Badge>
  );
};

const VoidStatusBadge = ({ status }: { status: VoidStatus }) => {
  if (!status) return <span className="text-ui-fg-muted text-xs">—</span>;
  if (status === "voided")
    return (
      <Badge color="purple" size="2xsmall">
        voided
      </Badge>
    );
  if (status === "error")
    return (
      <Badge color="red" size="2xsmall">
        void-err
      </Badge>
    );
  if (status === "processing")
    return (
      <Badge color="blue" size="2xsmall">
        voiding
      </Badge>
    );
  return (
    <Badge color="orange" size="2xsmall">
      void-pending
    </Badge>
  );
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
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({
    waiting: 0,
    processing: 0,
    synced: 0,
    error: 0,
    void: 0,
  });
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status !== "__all__") params.set("status", status);
      if (search.trim()) params.set("search", search.trim());
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const res = await fetch(
        `/admin/qb-catalog/inventory-adjustment-pipeline?${params}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        rows: PipelineRow[];
        count?: number;
        counts?: Partial<typeof counts>;
      };
      setRows(data.rows ?? []);
      setTotal(data.count ?? 0);
      setCounts((prev) => ({ ...prev, ...(data.counts ?? {}) }));
    } catch (e) {
      toast.error("Failed to load inventory adjustment pipeline", {
        description: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, [page, search, status]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    const interval = setInterval(fetchRows, 15000);
    return () => clearInterval(interval);
  }, [fetchRows]);

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
    <Container>
      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <Heading level="h3" className="text-sm font-medium flex items-center gap-2">
              📊 QB Inventory Adjustments
              {(counts.waiting > 0 || counts.processing > 0) && (
                <span className="inline-flex items-center gap-1 text-[10px] font-normal text-blue-600 animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
                  Live
                </span>
              )}
            </Heading>
            <Text className="text-xs text-ui-fg-subtle mt-0.5">
              Real-time queue of QuickBooks inventory adjustment sync — auto-refreshes every 15 s
            </Text>
          </div>
          <Button variant="secondary" size="small" onClick={fetchRows} isLoading={loading}>
            <ArrowPath className="mr-1" /> Refresh
          </Button>
        </div>

        {/* Summary badges */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {counts.waiting > 0 && <Badge color="orange" size="xsmall">Waiting {counts.waiting}</Badge>}
          {counts.processing > 0 && <Badge color="blue" size="xsmall">Processing {counts.processing}</Badge>}
          {counts.synced > 0 && <Badge color="green" size="xsmall">Synced {counts.synced}</Badge>}
          {counts.error > 0 && <Badge color="red" size="xsmall">Error {counts.error}</Badge>}
          {counts.void > 0 && <Badge color="purple" size="xsmall">Void {counts.void}</Badge>}
          {counts.waiting === 0 && counts.processing === 0 && counts.error === 0 && counts.synced === 0 && (
            <span className="text-xs text-ui-fg-muted">No operations recorded yet</span>
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
            }}
            className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base"
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Search count # / RefNumber / TxnID / error…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base w-52 placeholder:text-ui-fg-muted"
          />
          <span className="text-xs text-ui-fg-muted ml-auto">
            {total} total operation{total !== 1 ? "s" : ""}
          </span>
        </div>

        {loading && rows.length === 0 && (
          <Text className="text-ui-fg-subtle py-6 text-center">Loading…</Text>
        )}
        {!loading && rows.length === 0 && (
          <Text className="text-ui-fg-subtle py-6 text-center">No rows match.</Text>
        )}
        {rows.length > 0 && (
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
                {rows.map((r) => {
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
                      <Table.Cell>
                        <StatusBadge status={r.status} />
                      </Table.Cell>
                      <Table.Cell>
                        <VoidStatusBadge status={r.void_status} />
                      </Table.Cell>
                      <Table.Cell className="font-mono text-xs">
                        {r.qb_txn_number ?? "—"}
                      </Table.Cell>
                      <Table.Cell className="font-mono text-xs">
                        {r.qb_list_id ? (
                          <Tooltip content={r.qb_list_id}>
                            <span>{truncate(r.qb_list_id, 14)}</span>
                          </Tooltip>
                        ) : (
                          "—"
                        )}
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
                        ) : (
                          "—"
                        )}
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
        <PipelinePagination
          page={page}
          total={total}
          onPageChange={setPage}
        />
      </div>
    </Container>
  );
};
