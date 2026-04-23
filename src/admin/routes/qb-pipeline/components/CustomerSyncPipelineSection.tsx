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
import { Fragment, useEffect, useMemo, useState } from "react";

type PipelineRow = {
  id: string;
  seq: number;
  reference_id: string | null;
  step: string;
  status: string;
  error: string | null;
  retry_count: number;
  qb_txn_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
  failed_at: string | null;
};

type CustomerRow = PipelineRow & {
  customer_name: string;
  customer_email: string;
  acquisition_channel: string;
  qb_list_id: string | null;
  /** Independent Customer Sync index (1, 2, 3…) computed locally — NOT the
   * shared qb_order_pipeline.seq. Oldest row = #1. */
  display_seq: number;
};

const STATUS_FILTERS = [
  { label: "All", value: "__all__" },
  { label: "Pending", value: "pending" },
  { label: "Submitted", value: "submitted" },
  { label: "Confirmed", value: "confirmed" },
  { label: "Failed", value: "failed" },
];

const StatusBadge = ({ status }: { status: string }) => {
  if (status === "confirmed")
    return <Badge color="green" size="2xsmall">confirmed</Badge>;
  if (status === "failed")
    return <Badge color="red" size="2xsmall">failed</Badge>;
  if (status === "submitted")
    return <Badge color="blue" size="2xsmall">submitted</Badge>;
  return <Badge color="orange" size="2xsmall">{status}</Badge>;
};

export const CustomerSyncPipelineSection = () => {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("__all__");
  const [search, setSearch] = useState("");
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<{
    pending: number;
    submitted: number;
    confirmed: number;
    failed: number;
  }>({ pending: 0, submitted: 0, confirmed: 0, failed: 0 });

  const fetchRows = async () => {
    setLoading(true);
    try {
      // Traemos ambos steps: customer (add/mod del customer en QB)
      // y customer_data_ext (write del acquisition_channel como custom field).
      // Nota: el API de pipeline acepta un solo `step` por request, así que
      // hacemos dos fetches en paralelo y los mergeamos.
      const baseParams = (step: string) => {
        const p = new URLSearchParams({ step, limit: "100" });
        if (status !== "__all__") p.set("status", status);
        return p.toString();
      };
      const [res1, res2] = await Promise.all([
        fetch(`/admin/quickbooks/pipeline?${baseParams("customer")}`, {
          credentials: "include",
        }),
        fetch(`/admin/quickbooks/pipeline?${baseParams("customer_data_ext")}`, {
          credentials: "include",
        }),
      ]);
      if (!res1.ok) throw new Error(`${res1.status}`);
      if (!res2.ok) throw new Error(`${res2.status}`);
      const [data1, data2] = await Promise.all([res1.json(), res2.json()]);
      const pipeline: PipelineRow[] = [
        ...(data1.pipeline ?? []),
        ...(data2.pipeline ?? []),
      ].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      // Enrich each row with customer info
      const uniqueIds = [
        ...new Set(
          pipeline
            .map((r) => r.reference_id)
            .filter((x): x is string => typeof x === "string")
        ),
      ];
      let customerMap = new Map<
        string,
        { name: string; email: string; acq: string; list_id: string | null }
      >();
      if (uniqueIds.length > 0) {
        const cRes = await fetch(
          `/admin/customers?id[]=${uniqueIds.join("&id[]=")}&limit=${uniqueIds.length}&fields=id,first_name,last_name,email,metadata`,
          { credentials: "include" }
        );
        if (cRes.ok) {
          const cData = await cRes.json();
          for (const c of cData.customers ?? []) {
            const meta = (c.metadata ?? {}) as Record<string, unknown>;
            customerMap.set(c.id, {
              name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.email || c.id,
              email: c.email ?? "",
              acq:
                typeof meta.acquisition_channel === "string"
                  ? meta.acquisition_channel
                  : "",
              list_id:
                typeof meta.qb_list_id === "string" ? meta.qb_list_id : null,
            });
          }
        }
      }

      // display_seq: customer-sync-tab-only counter (#1 = oldest).
      // Computed over the combined pipeline array sorted by seq ASC,
      // then the rows stay in DESC order for UI consumption.
      const seqToDisplay = new Map<number, number>();
      [...pipeline]
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .forEach((r, i) => {
          if (typeof r.seq === "number") seqToDisplay.set(r.seq, i + 1);
        });

      const enriched: CustomerRow[] = pipeline.map((r) => {
        const info = r.reference_id ? customerMap.get(r.reference_id) : null;
        return {
          ...r,
          customer_name: info?.name ?? r.reference_id ?? "—",
          customer_email: info?.email ?? "",
          acquisition_channel: info?.acq ?? "",
          qb_list_id: info?.list_id ?? null,
          display_seq: seqToDisplay.get(r.seq) ?? 0,
        };
      });
      setRows(enriched);

      // Local counts from the combined rows (API `counts` includes all steps).
      const localCounts = { pending: 0, submitted: 0, confirmed: 0, failed: 0 };
      for (const r of pipeline) {
        if (r.status in localCounts) {
          (localCounts as any)[r.status]++;
        }
      }
      setCounts(localCounts);
    } catch (e: any) {
      toast.error(`Failed to fetch: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRows();
    const iv = setInterval(fetchRows, 10_000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter(
      (r) =>
        r.customer_name.toLowerCase().includes(q) ||
        r.customer_email.toLowerCase().includes(q) ||
        r.acquisition_channel.toLowerCase().includes(q) ||
        (r.qb_list_id ?? "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  const retry = async (id: string) => {
    setRetrying((s) => new Set(s).add(id));
    try {
      const res = await fetch(`/admin/quickbooks/pipeline/${id}/retry`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success("Retry queued");
      await fetchRows();
    } catch (e: any) {
      toast.error(`Retry failed: ${e.message}`);
    } finally {
      setRetrying((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  return (
    <Container className="flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Text className="text-ui-fg-subtle">
          Writes the customer's <strong>acquisition_channel</strong> to the QB
          custom field <em>Distribution Channel</em>. Rows are enqueued when
          a customer is created/updated with a valid channel and a qb_list_id.
        </Text>
        <Button
          size="small"
          variant="secondary"
          onClick={fetchRows}
          disabled={loading}
        >
          <ArrowPath /> Refresh
        </Button>
      </div>

      <div className="flex gap-2 text-xs">
        <Badge color="orange">Pending {counts.pending}</Badge>
        <Badge color="blue">Submitted {counts.submitted}</Badge>
        <Badge color="green">Confirmed {counts.confirmed}</Badge>
        <Badge color="red">Failed {counts.failed}</Badge>
      </div>

      <div className="flex gap-2 items-center flex-wrap">
        <Select value={status} onValueChange={setStatus}>
          <Select.Trigger className="w-40">
            <Select.Value placeholder="Status" />
          </Select.Trigger>
          <Select.Content>
            {STATUS_FILTERS.map((s) => (
              <Select.Item key={s.value} value={s.value}>
                {s.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
        <Input
          placeholder="Search customer / email / channel / QB ListID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-80"
        />
        <Text className="text-ui-fg-subtle ml-auto text-xs">
          {filtered.length} row{filtered.length === 1 ? "" : "s"}
        </Text>
      </div>

      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>#</Table.HeaderCell>
            <Table.HeaderCell>Customer</Table.HeaderCell>
            <Table.HeaderCell>Type</Table.HeaderCell>
            <Table.HeaderCell>Status</Table.HeaderCell>
            <Table.HeaderCell>QB ListID</Table.HeaderCell>
            <Table.HeaderCell>Retries</Table.HeaderCell>
            <Table.HeaderCell>Created</Table.HeaderCell>
            <Table.HeaderCell>Resolved</Table.HeaderCell>
            <Table.HeaderCell>Actions</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {filtered.length === 0 ? (
            <Table.Row>
              <Table.Cell>
                <Text className="text-ui-fg-subtle py-6 text-center">
                  {loading ? "Loading..." : "No rows."}
                </Text>
              </Table.Cell>
            </Table.Row>
          ) : (
            filtered.map((r) => {
              const resolved =
                r.confirmed_at ?? r.failed_at ?? null;
              const isDataExt = r.step === "customer_data_ext";
              const isExpanded = expanded.has(r.id);
              const toggleExpand = () =>
                setExpanded((s) => {
                  const n = new Set(s);
                  n.has(r.id) ? n.delete(r.id) : n.add(r.id);
                  return n;
                });
              return (
                <Fragment key={r.id}>
                  <Table.Row>
                    <Table.Cell className="font-mono text-sm text-ui-fg-subtle">
                      #{r.display_seq}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col">
                        <span className="font-medium">{r.customer_name}</span>
                        <span className="text-ui-fg-subtle text-xs">
                          {r.customer_email}
                        </span>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      {isDataExt ? (
                        <Badge
                          size="2xsmall"
                          color="purple"
                          className="whitespace-nowrap capitalize"
                        >
                          Channel: {r.acquisition_channel || "—"}
                        </Badge>
                      ) : (
                        <Badge size="2xsmall" color="grey">Customer</Badge>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <StatusBadge status={r.status} />
                    </Table.Cell>
                    <Table.Cell className="font-mono text-xs">
                      {r.qb_list_id ?? "—"}
                    </Table.Cell>
                    <Table.Cell>{r.retry_count}</Table.Cell>
                    <Table.Cell className="text-xs">
                      {new Date(r.created_at).toLocaleString()}
                    </Table.Cell>
                    <Table.Cell className="text-xs">
                      {resolved ? new Date(resolved).toLocaleString() : "—"}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex items-center gap-1">
                        {r.error ? (
                          <button
                            type="button"
                            onClick={toggleExpand}
                            className="text-[10px] text-ui-fg-error hover:underline whitespace-nowrap"
                          >
                            {isExpanded ? "▲ hide" : "▼ error"}
                          </button>
                        ) : null}
                        {r.status === "failed" ? (
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => retry(r.id)}
                            disabled={retrying.has(r.id)}
                          >
                            <ArrowPath /> Retry
                          </Button>
                        ) : null}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                  {isExpanded && r.error ? (
                    <tr className="bg-ui-bg-subtle border-b border-ui-border-base">
                      <td colSpan={9} className="px-4 py-2">
                        <pre className="text-[11px] text-ui-fg-error whitespace-pre-wrap break-all font-mono">
                          {r.error}
                        </pre>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </Table.Body>
      </Table>
    </Container>
  );
};
