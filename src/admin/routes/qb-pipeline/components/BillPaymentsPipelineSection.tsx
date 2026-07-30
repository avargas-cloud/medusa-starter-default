import { ArrowPath } from "@medusajs/icons";
import { Badge, Button, Container, Heading, Table, Text, toast } from "@medusajs/ui";
import { Fragment, useCallback, useEffect, useState } from "react";

import { PAGE_SIZE, PipelinePagination } from "./PipelinePagination";

/**
 * Bill Payments tab — the `vendor_bill_payment_check` step.
 *
 * QuickBooks Desktop cannot push payment webhooks, so an hourly monitor emits a
 * read-only BillQuery for every linked unpaid Vendor Bill. That makes this the
 * highest-volume step in the shared pipeline table by a wide margin (165 of the
 * 241 rows created in one day, against 76 for every other step combined), which is
 * why it needs its own tab instead of burying the sales documents.
 *
 * Pagination and counts are SERVER-side on purpose. Slicing a fixed first page in
 * the browser would silently under-report: with 750+ rows the filter would only
 * ever see whatever the first fetch happened to contain.
 */
type BillPaymentRow = {
  id: string;
  seq: number;
  tab_seq: number | null;
  reference_id: string | null;
  step: string;
  status: string;
  error: string | null;
  retry_count: number;
  qb_txn_id: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  failed_at: string | null;
  bill_number: string | null;
  bill_qb_ref_number: string | null;
  bill_vendor_name: string | null;
  bill_amount_due_cents: number | null;
  bill_balance_cents: number | null;
  bill_is_paid: boolean | null;
  bill_payment_checked_at: string | null;
  bill_missing_in_qb_at: string | null;
};

const STATUS_FILTERS = [
  { label: "All", value: "__all__" },
  { label: "Pending", value: "pending" },
  { label: "Submitted", value: "submitted" },
  { label: "Confirmed", value: "confirmed" },
  { label: "Failed", value: "failed" },
  { label: "Skipped", value: "skipped" },
];

const money = (cents: number | null): string =>
  cents == null
    ? "—"
    : (cents / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      });

const StatusBadge = ({ status }: { status: string }) => {
  if (status === "confirmed")
    return <Badge color="green" size="2xsmall">confirmed</Badge>;
  if (status === "failed")
    return <Badge color="red" size="2xsmall">failed</Badge>;
  if (status === "submitted")
    return <Badge color="blue" size="2xsmall">submitted</Badge>;
  if (status === "skipped")
    return <Badge color="grey" size="2xsmall">skipped</Badge>;
  return <Badge color="orange" size="2xsmall">{status}</Badge>;
};

export const BillPaymentsPipelineSection = () => {
  const [rows, setRows] = useState<BillPaymentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("__all__");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        step: "vendor_bill_payment_check",
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (status !== "__all__") params.set("status", status);
      if (search) params.set("search", search);
      const res = await fetch(`/admin/quickbooks/pipeline?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setRows(data.pipeline ?? []);
      setTotal(data.pagination?.total ?? 0);
      setCounts(data.counts ?? {});
    } catch (e: unknown) {
      toast.error(
        `Failed to fetch: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setLoading(false);
    }
  }, [page, status, search]);

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
      toast.error(
        `Retry failed: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setRetrying((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  const missingCount = rows.filter((r) => r.bill_missing_in_qb_at).length;

  return (
    <Container>
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <Heading level="h3" className="text-sm font-medium flex items-center gap-2">
              💵 QB Vendor Bill Payment Checks
              {((counts.pending ?? 0) > 0 || (counts.submitted ?? 0) > 0) && (
                <span className="inline-flex items-center gap-1 text-[10px] font-normal text-blue-600 animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
                  Live
                </span>
              )}
            </Heading>
            <Text className="text-xs text-ui-fg-subtle mt-0.5">
              Read-only BillQuery per linked unpaid bill — QuickBooks Desktop cannot
              push payment webhooks, so an hourly monitor polls instead. Auto-refreshes
              every 15 s.
            </Text>
          </div>
          <Button size="small" variant="secondary" onClick={fetchRows} isLoading={loading}>
            <ArrowPath className="mr-1" /> Refresh
          </Button>
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {(counts.pending ?? 0) > 0 && <Badge color="orange" size="xsmall">Pending {counts.pending}</Badge>}
          {(counts.submitted ?? 0) > 0 && <Badge color="blue" size="xsmall">Submitted {counts.submitted}</Badge>}
          {(counts.confirmed ?? 0) > 0 && <Badge color="green" size="xsmall">Confirmed {counts.confirmed}</Badge>}
          {(counts.failed ?? 0) > 0 && <Badge color="red" size="xsmall">Failed {counts.failed}</Badge>}
          {(counts.skipped ?? 0) > 0 && <Badge color="grey" size="xsmall">Skipped {counts.skipped}</Badge>}
          {missingCount > 0 && (
            <Badge color="red" size="xsmall">
              Gone from QuickBooks {missingCount} on this page
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
            }}
            className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Search bill # or QB ref..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base w-72 placeholder:text-ui-fg-muted"
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
                  <Table.HeaderCell>Bill</Table.HeaderCell>
                  <Table.HeaderCell>QB Ref</Table.HeaderCell>
                  <Table.HeaderCell>Amount</Table.HeaderCell>
                  <Table.HeaderCell>Paid</Table.HeaderCell>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                  <Table.HeaderCell>Retries</Table.HeaderCell>
                  <Table.HeaderCell>Checked</Table.HeaderCell>
                  <Table.HeaderCell>Actions</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((r) => {
                  const isExpanded = expanded.has(r.id);
                  const toggleExpand = () =>
                    setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(r.id)) n.delete(r.id);
                      else n.add(r.id);
                      return n;
                    });
                  return (
                    <Fragment key={r.id}>
                      <Table.Row>
                        <Table.Cell className="font-mono text-sm text-ui-fg-subtle">
                          #{r.tab_seq ?? r.seq}
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex flex-col">
                            <span className="font-medium">
                              {r.bill_number ?? r.bill_qb_ref_number ?? "—"}
                            </span>
                            <span className="text-ui-fg-subtle text-xs">
                              {r.bill_vendor_name ?? r.reference_id ?? ""}
                            </span>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="font-mono text-xs">
                          {r.bill_qb_ref_number ?? "—"}
                          {r.bill_missing_in_qb_at ? (
                            <Badge color="red" size="2xsmall" className="ml-1 whitespace-nowrap">
                              gone from QB
                            </Badge>
                          ) : null}
                        </Table.Cell>
                        <Table.Cell className="text-xs">
                          {money(r.bill_amount_due_cents)}
                        </Table.Cell>
                        <Table.Cell>
                          {r.bill_is_paid == null ? (
                            "—"
                          ) : r.bill_is_paid ? (
                            <Badge color="green" size="2xsmall">paid</Badge>
                          ) : (
                            <Badge color="orange" size="2xsmall">open</Badge>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          <StatusBadge status={r.status} />
                        </Table.Cell>
                        <Table.Cell>{r.retry_count}</Table.Cell>
                        <Table.Cell className="text-xs">
                          {r.bill_payment_checked_at
                            ? new Date(r.bill_payment_checked_at).toLocaleString()
                            : "—"}
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
                })}
              </Table.Body>
            </Table>
          </div>
        )}
        <PipelinePagination page={page} total={total} onPageChange={setPage} />
      </div>
    </Container>
  );
};
