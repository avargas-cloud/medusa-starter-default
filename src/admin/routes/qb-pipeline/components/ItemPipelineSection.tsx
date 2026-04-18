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

type PipelineRow = {
  id: string;
  variant_id: string;
  sku: string;
  item_type: "Inventory" | "Service" | "NonInventory";
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

const StatusBadge = ({ status }: { status: PipelineRow["status"] }) => {
  if (status === "synced")
    return <Badge color="green" size="2xsmall">synced</Badge>;
  if (status === "error")
    return <Badge color="red" size="2xsmall">error</Badge>;
  return <Badge color="orange" size="2xsmall">waiting</Badge>;
};

export const ItemPipelineSection = () => {
  const [rows, setRows] = useState<PipelineRow[]>([]);
  const [counts, setCounts] = useState<Counts>({
    waiting: 0,
    synced: 0,
    error: 0,
  });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("__all__");
  const [search, setSearch] = useState("");
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  const fetchRows = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status !== "__all__") params.set("status", status);
      const res = await fetch(`/admin/qb-catalog/pipeline?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.rows ?? []);
      setCounts(data.counts ?? { waiting: 0, synced: 0, error: 0 });
    } catch (e) {
      toast.error("Failed to load item pipeline", {
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
      [r.sku, r.qb_list_id, r.last_error]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(s)
    );
  }, [rows, search]);

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
    <div className="flex flex-col gap-4">
      <div className="flex gap-3">
        <Badge color="orange" size="small">
          Waiting: {counts.waiting}
        </Badge>
        <Badge color="green" size="small">
          Synced: {counts.synced}
        </Badge>
        <Badge color="red" size="small">
          Error: {counts.error}
        </Badge>
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
            placeholder="Search SKU / ListID / error…"
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
                  <Table.HeaderCell>SKU</Table.HeaderCell>
                  <Table.HeaderCell>Type</Table.HeaderCell>
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
                  <Table.Row key={r.id}>
                    <Table.Cell className="font-mono text-sm">
                      {r.sku}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="2xsmall">{r.item_type}</Badge>
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
                    <Table.Cell className="max-w-xs">
                      {r.last_error ? (
                        <Tooltip content={r.last_error}>
                          <span className="text-ui-fg-error text-xs truncate block">
                            {r.last_error}
                          </span>
                        </Tooltip>
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
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </Container>
    </div>
  );
};
