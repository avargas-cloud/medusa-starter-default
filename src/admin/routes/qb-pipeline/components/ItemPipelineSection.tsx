import { ArrowPath } from "@medusajs/icons";
import {
  Badge,
  Button,
  Container,
  Heading,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import { Fragment, useCallback, useEffect, useState } from "react";

import { PAGE_SIZE, PipelinePagination } from "./PipelinePagination";

type PipelineStatus = "waiting" | "synced" | "error" | "failed_permanent";

type PipelineRow = {
  id: string;
  seq: number;
  variant_id: string;
  sku: string;
  item_type: "Inventory" | "Service" | "NonInventory";
  status: PipelineStatus;
  op_action: "add" | "mod" | null;
  qb_list_id: string | null;
  qb_operation_id: string | null;
  last_error: string | null;
  retries: number;
  next_retry_at: string | null;
  failed_at: string | null;
  resolved_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type Counts = {
  waiting: number;
  synced: number;
  error: number;
  failed_permanent: number;
};

const STATUS_FILTERS = [
  { label: "All", value: "__all__" },
  { label: "Waiting", value: "waiting" },
  { label: "Synced", value: "synced" },
  { label: "Error", value: "error" },
  { label: "Failed Permanent", value: "failed_permanent" },
];

const StatusBadge = ({ status }: { status: PipelineRow["status"] }) => {
  if (status === "synced")
    return (
      <Badge color="green" size="2xsmall">
        synced
      </Badge>
    );
  if (status === "failed_permanent")
    return (
      <Badge color="red" size="2xsmall">
        failed permanent
      </Badge>
    );
  if (status === "error")
    return (
      <Badge color="red" size="2xsmall">
        error
      </Badge>
    );
  return (
    <Badge color="orange" size="2xsmall">
      waiting
    </Badge>
  );
};

const ActionBadge = ({ action }: { action: "add" | "mod" | null }) => {
  if (action === "mod")
    return (
      <Badge color="blue" size="2xsmall">
        mod
      </Badge>
    );
  return (
    <Badge color="grey" size="2xsmall">
      add
    </Badge>
  );
};

export const ItemPipelineSection = () => {
  const [rows, setRows] = useState<PipelineRow[]>([]);
  const [counts, setCounts] = useState<Counts>({
    waiting: 0,
    synced: 0,
    error: 0,
    failed_permanent: 0,
  });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("__all__");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status !== "__all__") params.set("status", status);
      if (search.trim()) params.set("search", search.trim());
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const res = await fetch(`/admin/qb-catalog/pipeline?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.rows ?? []);
      setCounts(
        data.counts ?? {
          waiting: 0,
          synced: 0,
          error: 0,
          failed_permanent: 0,
        }
      );
      setTotal(data.pagination?.total ?? 0);
    } catch (e) {
      toast.error("Failed to load item pipeline", {
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
      const res = await fetch(`/admin/qb-catalog/pipeline/${row.id}/retry`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error ?? "Retry failed");
      toast.success("Re-queued", { description: data.message });
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

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString() : "—";

  return (
    <Container>
      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <Heading level="h3" className="text-sm font-medium flex items-center gap-2">
              📦 QB Item Pipeline
              {counts.waiting > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-normal text-blue-600 animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
                  Live
                </span>
              )}
            </Heading>
            <Text className="text-xs text-ui-fg-subtle mt-0.5">
              Real-time queue of QuickBooks item sync operations — auto-refreshes every 15 s
            </Text>
          </div>
          <Button variant="secondary" size="small" onClick={fetchRows} isLoading={loading}>
            <ArrowPath className="mr-1" /> Refresh
          </Button>
        </div>

        {/* Summary badges */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {counts.waiting > 0 && <Badge color="orange" size="xsmall">Waiting {counts.waiting}</Badge>}
          {counts.synced > 0 && <Badge color="green" size="xsmall">Synced {counts.synced}</Badge>}
          {counts.error > 0 && <Badge color="red" size="xsmall">Error {counts.error}</Badge>}
          {counts.failed_permanent > 0 && <Badge color="red" size="xsmall">Failed {counts.failed_permanent}</Badge>}
          {counts.waiting === 0 && counts.error === 0 && counts.failed_permanent === 0 && counts.synced === 0 && (
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
            placeholder="Search SKU / ListID / error…"
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
          <div className="overflow-x-auto rounded border border-ui-border-base">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>#</Table.HeaderCell>
                  <Table.HeaderCell>SKU</Table.HeaderCell>
                  <Table.HeaderCell>Type</Table.HeaderCell>
                  <Table.HeaderCell>Op</Table.HeaderCell>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                  <Table.HeaderCell>QB ListID</Table.HeaderCell>
                  <Table.HeaderCell>Retries</Table.HeaderCell>
                  <Table.HeaderCell>Next Retry</Table.HeaderCell>
                  <Table.HeaderCell>Created</Table.HeaderCell>
                  <Table.HeaderCell>Resolved</Table.HeaderCell>
                  <Table.HeaderCell>Error</Table.HeaderCell>
                  <Table.HeaderCell>Actions</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                  <Table.Row>
                    <Table.Cell className="font-mono text-sm text-ui-fg-subtle">
                      #{r.seq ?? "—"}
                    </Table.Cell>
                    <Table.Cell className="font-mono text-sm">
                      {r.sku}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="2xsmall">{r.item_type}</Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <ActionBadge action={r.op_action} />
                    </Table.Cell>
                    <Table.Cell>
                      <StatusBadge status={r.status} />
                    </Table.Cell>
                    <Table.Cell className="font-mono text-xs">
                      {r.qb_list_id ?? "—"}
                    </Table.Cell>
                    <Table.Cell>{r.retries}</Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-xs">
                      {fmt(r.next_retry_at)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-xs">
                      {fmt(r.created_at)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-xs">
                      {fmt(r.resolved_at)}
                    </Table.Cell>
                    <Table.Cell>
                      {r.last_error ? (
                        <button
                          type="button"
                          onClick={() => toggleExpand(r.id)}
                          className="text-[10px] text-ui-fg-error hover:underline whitespace-nowrap"
                        >
                          {expanded.has(r.id) ? "▲ hide" : "▼ error"}
                        </button>
                      ) : "—"}
                    </Table.Cell>
                    <Table.Cell>
                      {(r.status === "error" || r.status === "failed_permanent") && (
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
                    <tr className="bg-ui-bg-subtle border-b border-ui-border-base">
                      <td colSpan={12} className="px-4 py-2">
                        <pre className="text-[11px] text-ui-fg-error whitespace-pre-wrap break-all font-mono">
                          {r.last_error}
                        </pre>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
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
