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
import React, { useEffect, useMemo, useState } from "react";

type VendorPipelineRow = {
  id: string;
  seq: number;
  vendor_id: string;
  vendor_name: string;
  op_type: "create" | "update" | string;
  status: "waiting" | "synced" | "error";
  qb_list_id: string | null;
  qb_operation_id: string | null;
  last_error: string | null;
  retries: number;
  resolved_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type Counts = { waiting: number; synced: number; error: number };

const STATUS_FILTERS = [
  { label: "All", value: "__all__" },
  { label: "Waiting", value: "waiting" },
  { label: "Synced", value: "synced" },
  { label: "Error", value: "error" },
];

const StatusBadge = ({ status }: { status: VendorPipelineRow["status"] }) => {
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
  return (
    <Badge color="orange" size="2xsmall">
      waiting
    </Badge>
  );
};

export const VendorPipelineSection = () => {
  const [rows, setRows] = useState<VendorPipelineRow[]>([]);
  const [counts, setCounts] = useState<Counts>({
    waiting: 0,
    synced: 0,
    error: 0,
  });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("__all__");
  const [search, setSearch] = useState("");
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
      const res = await fetch(`/admin/qb-catalog/vendor-pipeline?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.rows ?? []);
      setCounts(data.counts ?? { waiting: 0, synced: 0, error: 0 });
    } catch (e) {
      toast.error("Failed to load vendor pipeline", {
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
      [r.vendor_name, r.qb_list_id, r.last_error]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(s)
    );
  }, [rows, search]);

  const retry = async (row: VendorPipelineRow) => {
    setRetrying((prev) => new Set(prev).add(row.id));
    try {
      const res = await fetch(
        `/admin/qb-catalog/vendor-pipeline/${row.id}/retry`,
        { method: "POST", credentials: "include" }
      );
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
              🏢 QB Vendor Pipeline
              {counts.waiting > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-normal text-blue-600 animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
                  Live
                </span>
              )}
            </Heading>
            <Text className="text-xs text-ui-fg-subtle mt-0.5">
              Real-time queue of QuickBooks vendor sync operations — auto-refreshes every 15 s
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
          {counts.waiting === 0 && counts.error === 0 && counts.synced === 0 && (
            <span className="text-xs text-ui-fg-muted">No operations recorded yet</span>
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base"
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Search vendor / ListID / error…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base w-52 placeholder:text-ui-fg-muted"
          />
          <span className="text-xs text-ui-fg-muted ml-auto">
            {filtered.length} total operation{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>

        {loading && rows.length === 0 && (
          <Text className="text-ui-fg-subtle py-6 text-center">Loading…</Text>
        )}
        {!loading && filtered.length === 0 && (
          <Text className="text-ui-fg-subtle py-6 text-center">No rows match.</Text>
        )}
        {filtered.length > 0 && (
          <div className="max-h-[calc(100vh-380px)] overflow-y-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>#</Table.HeaderCell>
                  <Table.HeaderCell>Vendor</Table.HeaderCell>
                  <Table.HeaderCell>Op</Table.HeaderCell>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                  <Table.HeaderCell>QB ListID</Table.HeaderCell>
                  <Table.HeaderCell>Retries</Table.HeaderCell>
                  <Table.HeaderCell>Created</Table.HeaderCell>
                  <Table.HeaderCell>Resolved</Table.HeaderCell>
                  <Table.HeaderCell>Error</Table.HeaderCell>
                  <Table.HeaderCell>Actions</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filtered.map((r) => (
                  <React.Fragment key={r.id}>
                    <Table.Row>
                      <Table.Cell className="font-mono text-sm text-ui-fg-subtle">
                        #{r.seq}
                      </Table.Cell>
                      <Table.Cell className="font-medium text-sm">
                        {r.vendor_name}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge size="2xsmall">{r.op_type}</Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <StatusBadge status={r.status} />
                      </Table.Cell>
                      <Table.Cell className="font-mono text-xs">
                        {r.qb_list_id ?? "—"}
                      </Table.Cell>
                      <Table.Cell>{r.retries}</Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-xs">
                        {fmt(r.created_at)}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-xs">
                        {fmt(r.resolved_at)}
                      </Table.Cell>
                      <Table.Cell>
                        {r.last_error ? (
                          <button
                            onClick={() => toggleExpand(r.id)}
                            className="text-xs text-ui-fg-error hover:underline whitespace-nowrap"
                          >
                            {expanded.has(r.id) ? "▲ hide" : "▼ error"}
                          </button>
                        ) : (
                          "—"
                        )}
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
                        <td colSpan={10} className="px-6 py-2">
                          <p className="text-xs text-ui-fg-error font-mono break-words whitespace-pre-wrap">
                            {r.last_error}
                          </p>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </div>
    </Container>
  );
};
