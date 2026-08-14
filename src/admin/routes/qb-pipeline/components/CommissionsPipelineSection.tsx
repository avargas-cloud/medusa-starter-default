import { ArrowPath } from "@medusajs/icons";
import { Badge, Button, Container, Heading, Table, Text, toast } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";

import { PAGE_SIZE, PipelinePagination } from "./PipelinePagination";

/**
 * Commissions Pipeline tab — el lane propio de las comisiones por orden
 * (delta v2 de docs/ORDER_COMMISSIONS_PLAN.md).
 *
 * Dos steps por liquidación store_credit, en cadena:
 *   `commission_check`   → CheckAdd desde la clearing al vendor (Dr gasto / Cr clearing)
 *   `commission_payment` → ReceivePaymentAdd sin aplicar al customer, depositado a la
 *                          MISMA clearing — nace `waiting` y despierta cuando el check
 *                          confirma (la clearing nunca devuelve plata que no recibió).
 *
 * Excluidos del Sales Pipeline en sus TRES lectores (sales-pipeline-scope.ts).
 */
type CommissionPipelineRow = {
  id: string;
  medusa_ref_number: string | null;
  reference_id: string | null;
  step: string;
  status: string;
  error: string | null;
  retry_count: number;
  qb_txn_id: string | null;
  depends_on: string | null;
  created_at: string;
  updated_at: string;
};

const STATUS_FILTERS = [
  { label: "All", value: "__all__" },
  { label: "Pending", value: "pending" },
  { label: "Waiting", value: "waiting" },
  { label: "Submitted", value: "submitted" },
  { label: "Confirmed", value: "confirmed" },
  { label: "Failed", value: "failed" },
  { label: "Fixed", value: "fixed" },
  { label: "Skipped", value: "skipped" },
];

const StatusBadge = ({ status }: { status: string }) => {
  if (status === "confirmed") return <Badge color="green" size="2xsmall">confirmed</Badge>;
  if (status === "failed") return <Badge color="red" size="2xsmall">failed</Badge>;
  if (status === "submitted") return <Badge color="blue" size="2xsmall">submitted</Badge>;
  if (status === "waiting") return <Badge color="grey" size="2xsmall">waiting</Badge>;
  if (status === "skipped") return <Badge color="grey" size="2xsmall">skipped</Badge>;
  return <Badge color="orange" size="2xsmall">{status}</Badge>;
};

const StepBadge = ({ step }: { step: string }) =>
  step === "commission_check" ? (
    <Badge color="purple" size="2xsmall">check → vendor</Badge>
  ) : (
    <Badge color="blue" size="2xsmall">payment → customer</Badge>
  );

export const CommissionsPipelineSection = () => {
  const [rows, setRows] = useState<CommissionPipelineRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("__all__");
  const [page, setPage] = useState(0);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        tab: "commissions",
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (status !== "__all__") params.set("status", status);
      const res = await fetch(`/admin/quickbooks/pipeline?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setRows(data.pipeline ?? []);
      setTotal(data.pagination?.total ?? 0);
      setCounts(data.counts ?? {});
    } catch (e: unknown) {
      toast.error(`Failed to fetch: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    fetchRows();
    const iv = setInterval(fetchRows, 15_000);
    return () => clearInterval(iv);
  }, [fetchRows]);

  const retry = async (id: string) => {
    setRetrying((s) => new Set(s).add(id));
    try {
      const res = await fetch(
        `/admin/quickbooks/pipeline?action=retry&id=${encodeURIComponent(id)}`,
        { method: "POST", credentials: "include" }
      );
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success("Retry queued");
      await fetchRows();
    } catch (e: unknown) {
      toast.error(`Retry failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRetrying((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  return (
    <Container>
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <Heading level="h3" className="text-sm font-medium flex items-center gap-2">
              🤝 Order Commissions Pipeline
              {((counts.pending ?? 0) > 0 || (counts.submitted ?? 0) > 0) && (
                <span className="inline-flex items-center gap-1 text-[10px] font-normal text-blue-600 animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
                  Live
                </span>
              )}
            </Heading>
            <Text className="text-xs text-ui-fg-subtle mt-0.5">
              Each store-credit settlement is TWO chained documents: the clearing check
              to the vendor, and the unapplied payment that materializes the
              customer's credit. The payment waits for the check. Auto-refreshes
              every 15 s.
            </Text>
          </div>
          <Button size="small" variant="secondary" onClick={fetchRows} isLoading={loading}>
            <ArrowPath className="mr-1" /> Refresh
          </Button>
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => {
                setStatus(f.value);
                setPage(0);
              }}
              className={`px-2 py-0.5 rounded text-xs border ${
                status === f.value
                  ? "bg-ui-bg-base-pressed border-ui-fg-interactive font-semibold"
                  : "border-ui-border-base text-ui-fg-subtle"
              }`}
            >
              {f.label}
              {f.value !== "__all__" && (counts[f.value] ?? 0) > 0
                ? ` ${counts[f.value]}`
                : ""}
            </button>
          ))}
        </div>

        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>REF</Table.HeaderCell>
              <Table.HeaderCell>Step</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>QB TxnID</Table.HeaderCell>
              <Table.HeaderCell>Error</Table.HeaderCell>
              <Table.HeaderCell>Retries</Table.HeaderCell>
              <Table.HeaderCell>Updated</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.length === 0 && !loading && (
              <Table.Row>
                <Table.Cell className="text-ui-fg-subtle text-xs">
                  No commission operations yet.
                </Table.Cell>
                <Table.Cell /><Table.Cell /><Table.Cell />
                <Table.Cell /><Table.Cell /><Table.Cell /><Table.Cell />
              </Table.Row>
            )}
            {rows.map((r) => (
              <Table.Row key={r.id}>
                <Table.Cell className="text-xs font-mono">
                  {r.medusa_ref_number ?? r.reference_id ?? "—"}
                </Table.Cell>
                <Table.Cell><StepBadge step={r.step} /></Table.Cell>
                <Table.Cell><StatusBadge status={r.status} /></Table.Cell>
                <Table.Cell className="text-xs font-mono">{r.qb_txn_id ?? "—"}</Table.Cell>
                <Table.Cell className="text-xs text-red-600 max-w-[280px] truncate" title={r.error ?? ""}>
                  {r.error ?? "—"}
                </Table.Cell>
                <Table.Cell className="text-xs">{r.retry_count ?? 0}</Table.Cell>
                <Table.Cell className="text-xs">
                  {new Date(r.updated_at ?? r.created_at).toLocaleString()}
                </Table.Cell>
                <Table.Cell>
                  {r.status === "failed" && (
                    <Button
                      size="small"
                      variant="secondary"
                      isLoading={retrying.has(r.id)}
                      onClick={() => retry(r.id)}
                    >
                      Retry
                    </Button>
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>

        <PipelinePagination page={page} total={total} onPageChange={setPage} />
      </div>
    </Container>
  );
};
