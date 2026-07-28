import { ArrowPath } from "@medusajs/icons";
import { Badge, Button, Container, Heading, Text } from "@medusajs/ui";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { PAGE_SIZE, PipelinePagination } from "./PipelinePagination";

// ─── Types ────────────────────────────────────────────────────────────────────

type PoStatus =
  | "waiting"
  | "processing"
  | "submitted"
  | "completed"
  | "error"
  | "synced"
  | "failed_permanent";
type PoStep =
  | "purchase_order"
  | "void_purchase_order"
  | "mod_purchase_order"
  | "add_item_receipt"
  | "mod_item_receipt"
  | "delete_item_receipt"
  | "add_vendor_bill"
  | "mod_vendor_bill"
  | "preflight_vendor_bill_rebuild"
  | "delete_vendor_bill_rebuild"
  | "delete_vendor_bill";

interface PoRow {
  id: string;
  seq: number | null;
  seq_label: string | null;
  parent_id: string;
  po_number: string | null;
  draft_number: string | null;
  receipt_number: string | null;
  vendor_bill_number: string | null;
  vendor_name: string | null;
  status: PoStatus;
  step: PoStep;
  qb_operation_id: string | null;
  qb_list_id: string | null;
  qb_txn_number: string | null;
  last_error: string | null;
  retries: number;
  synced_at: string | null;
  created_at: string;
  updated_at: string | null;
}

interface Counts {
  waiting: number;
  processing: number;
  submitted: number;
  completed: number;
  error: number;
  synced: number;
  failed_permanent: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const STEP_ICON: Record<PoStep, string> = {
  purchase_order: "🛒",
  void_purchase_order: "🚫",
  mod_purchase_order: "✏️",
  add_item_receipt: "📦",
  mod_item_receipt: "✏️",
  delete_item_receipt: "🗑️",
  add_vendor_bill: "🧾",
  mod_vendor_bill: "✏️",
  preflight_vendor_bill_rebuild: "🔎",
  delete_vendor_bill_rebuild: "🧹",
  delete_vendor_bill: "🗑️",
};

const STEP_LABEL: Record<PoStep, string> = {
  purchase_order: "Purchase Order",
  void_purchase_order: "Void PO",
  mod_purchase_order: "Modify PO",
  add_item_receipt: "Item Receipt",
  mod_item_receipt: "Modify Receipt",
  delete_item_receipt: "Delete Receipt",
  add_vendor_bill: "Vendor Bill",
  mod_vendor_bill: "Modify Bill",
  preflight_vendor_bill_rebuild: "Verify Bill Rebuild",
  delete_vendor_bill_rebuild: "Prepare Bill Rebuild",
  delete_vendor_bill: "Delete Bill",
};

type BadgeColor = "orange" | "blue" | "green" | "red" | "grey";

function StatusBadge({ status }: { status: PoStatus }) {
  const map: Record<PoStatus, { color: BadgeColor; label: string }> = {
    waiting: { color: "orange", label: "Waiting" },
    processing: { color: "blue", label: "Processing" },
    submitted: { color: "blue", label: "Submitted" },
    completed: { color: "green", label: "Completed" },
    error: { color: "red", label: "Error" },
    synced: { color: "green", label: "Synced" },
    failed_permanent: { color: "red", label: "Failed" },
  };
  const s = map[status] ?? { color: "grey" as BadgeColor, label: status };
  return (
    <Badge color={s.color} size="xsmall">
      {s.label}
    </Badge>
  );
}

function formatDate(iso: string | null): ReactNode {
  if (!iso) return "—";
  const d = new Date(iso);
  const tz = "America/New_York";
  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  const dateStr = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
  const todayStr = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
  if (dateStr === todayStr) return timeStr;
  return (
    <span className="flex flex-col leading-tight">
      <span>{dateStr}</span>
      <span className="text-[10px] opacity-60">{timeStr}</span>
    </span>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function PipelinePoRow({
  row,
  onRetry,
  onMarkFixed,
  retrying,
  markingFixed,
}: {
  row: PoRow;
  onRetry: (id: string) => void;
  onMarkFixed: (id: string) => void;
  retrying: boolean;
  markingFixed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const step = (row.step ?? "purchase_order") as PoStep;
  const isReviewedRebuild =
    step === "preflight_vendor_bill_rebuild" ||
    step === "delete_vendor_bill_rebuild";

  const updatedAt =
    row.status === "synced" ? row.synced_at : (row.updated_at ?? null);

  return (
    <>
      <tr
        className={`border-b border-ui-border-base text-xs transition-colors ${
          row.status === "error" || row.status === "failed_permanent"
            ? "bg-red-50/5"
            : row.status === "submitted"
              ? "bg-blue-50/5"
              : row.status === "waiting"
                ? "bg-yellow-50/5"
                : ""
        }`}
      >
        {/* Seq */}
        <td className="px-3 py-2 whitespace-nowrap">
          <span className="font-mono text-[11px] text-ui-fg-muted">
            #{row.seq_label ?? "—"}
          </span>
        </td>

        {/* Step */}
        <td className="px-3 py-2 whitespace-nowrap">
          <span className="flex items-center gap-1.5">
            <span>{STEP_ICON[step] ?? "📎"}</span>
            <span className="font-medium text-ui-fg-base">
              {STEP_LABEL[step] ?? step}
            </span>
          </span>
        </td>

        {/* PO # / Receipt # / Bill # */}
        <td className="px-3 py-2 whitespace-nowrap">
          <span className="flex flex-col leading-tight">
            <span className="font-mono font-semibold text-ui-fg-base">
              {row.po_number ?? row.draft_number ?? "—"}
            </span>
            {row.receipt_number && (
              <span className="font-mono text-[10px] text-emerald-600 font-semibold">
                {row.receipt_number}
              </span>
            )}
            {row.vendor_bill_number && (
              <span className="font-mono text-[10px] text-violet-600 font-semibold">
                {row.vendor_bill_number}
              </span>
            )}
          </span>
        </td>

        {/* QB Ref # */}
        <td className="px-3 py-2 whitespace-nowrap">
          {row.qb_txn_number ? (
            <span className="font-mono text-xs text-violet-600 font-semibold">
              {row.qb_txn_number}
            </span>
          ) : row.status === "synced" ? (
            <span className="text-ui-fg-muted">—</span>
          ) : (
            <span className="text-ui-fg-muted text-[10px]">pending…</span>
          )}
        </td>

        {/* Vendor */}
        <td className="px-3 py-2 text-ui-fg-subtle max-w-[180px] truncate">
          {row.vendor_name ?? "—"}
        </td>

        {/* Status */}
        <td className="px-3 py-2 whitespace-nowrap">
          <StatusBadge status={row.status} />
        </td>

        {/* QB ListID / Op */}
        <td className="px-3 py-2 font-mono text-[11px] text-ui-fg-subtle">
          {row.qb_list_id ? (
            <span className="text-green-700 font-semibold">
              {row.qb_list_id}
            </span>
          ) : row.qb_operation_id ? (
            <span className="text-blue-600">
              op:{row.qb_operation_id.slice(-6)}
            </span>
          ) : (
            <span className="text-ui-fg-muted">—</span>
          )}
        </td>

        {/* Retries */}
        <td className="px-3 py-2 text-center text-ui-fg-muted">
          {row.retries > 0 ? (
            <span className="text-orange-600 font-semibold">{row.retries}</span>
          ) : (
            "0"
          )}
        </td>

        {/* Created */}
        <td className="px-3 py-2 text-ui-fg-muted">
          {formatDate(row.created_at)}
        </td>

        {/* Updated */}
        <td className="px-3 py-2">
          {updatedAt ? (
            <span
              className={
                row.status === "synced"
                  ? "text-green-500"
                  : row.status === "error" || row.status === "failed_permanent"
                    ? "text-red-400"
                    : row.status === "submitted"
                      ? "text-blue-400"
                      : "text-ui-fg-subtle"
              }
            >
              {formatDate(updatedAt)}
            </span>
          ) : (
            <span className="text-ui-fg-muted">—</span>
          )}
        </td>

        {/* Actions */}
        <td className="px-3 py-2">
          <div className="flex items-center gap-1">
            {row.last_error && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="text-[10px] text-red-600 hover:underline"
              >
                {expanded ? "▲ hide" : "▼ error"}
              </button>
            )}
            {(row.status === "error" ||
              row.status === "waiting" ||
              row.status === "failed_permanent") && (
              <button
                onClick={() => onRetry(row.id)}
                disabled={retrying}
                className="ml-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-ui-button-neutral hover:bg-ui-button-neutral-hover text-ui-fg-base border border-ui-border-base disabled:opacity-50"
              >
                {retrying ? "…" : "Retry"}
              </button>
            )}
            {(row.status === "error" || row.status === "failed_permanent") &&
              !isReviewedRebuild && (
              <button
                onClick={() => {
                  if (
                    confirm(
                      "Mark as Fixed? Use only if you resolved this manually in QuickBooks Desktop."
                    )
                  ) {
                    onMarkFixed(row.id);
                  }
                }}
                disabled={markingFixed}
                className="ml-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-ui-button-neutral hover:bg-ui-button-neutral-hover text-ui-fg-base border border-ui-border-base disabled:opacity-50"
              >
                {markingFixed ? "…" : "Mark Fixed"}
              </button>
            )}
          </div>
        </td>
      </tr>

      {expanded && row.last_error && (
        <tr className="bg-red-50/5 border-b border-ui-border-base">
          <td colSpan={11} className="px-4 py-2">
            <pre className="text-[10px] text-red-400 whitespace-pre-wrap break-all font-mono">
              {row.last_error}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export const PurchaseOrderPipelineSection = () => {
  const [rows, setRows] = useState<PoRow[]>([]);
  const [counts, setCounts] = useState<Counts>({
    waiting: 0,
    processing: 0,
    submitted: 0,
    completed: 0,
    error: 0,
    synced: 0,
    failed_permanent: 0,
  });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [markingFixedId, setMarkingFixedId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRows = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const params = new URLSearchParams();
        if (statusFilter !== "all") params.set("status", statusFilter);
        if (searchQuery.trim()) params.set("search", searchQuery.trim());
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String(page * PAGE_SIZE));
        const res = await fetch(
          `/admin/purchase-orders/qb-pipeline?${params}`,
          { credentials: "include" }
        );
        if (!res.ok) return;
        const data = await res.json();
        setRows(data.rows ?? []);
        setCounts(
          data.counts ?? {
            waiting: 0,
            processing: 0,
            submitted: 0,
            completed: 0,
            error: 0,
            synced: 0,
            failed_permanent: 0,
          }
        );
        setTotal(data.pagination?.total ?? 0);
      } catch {
        /* non-blocking */
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [page, statusFilter, searchQuery]
  );

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (counts.waiting > 0 || counts.processing > 0 || counts.submitted > 0) {
      intervalRef.current = setInterval(() => fetchRows(true), 10_000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [counts.waiting, counts.processing, counts.submitted, fetchRows]);

  const handleRetry = async (id: string) => {
    setRetryingId(id);
    try {
      const res = await fetch(
        `/admin/purchase-orders/qb-pipeline/${id}/retry`,
        { method: "POST", credentials: "include" }
      );
      const data = await res.json();
      if (res.ok && data.success) await fetchRows(true);
    } catch {
      /* non-blocking */
    } finally {
      setRetryingId(null);
    }
  };

  const handleMarkFixed = async (id: string) => {
    setMarkingFixedId(id);
    try {
      await fetch(`/admin/purchase-orders/qb-pipeline/${id}/mark-fixed`, {
        method: "POST",
        credentials: "include",
      });
      await fetchRows(true);
    } catch {
      /* non-blocking */
    } finally {
      setMarkingFixedId(null);
    }
  };

  const hasPending =
    counts.waiting > 0 || counts.processing > 0 || counts.submitted > 0;

  return (
    <Container>
      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <Heading
              level="h3"
              className="text-sm font-medium flex items-center gap-2"
            >
              🏭 QB Purchases Pipeline
              {hasPending && (
                <span className="inline-flex items-center gap-1 text-[10px] font-normal text-blue-600 animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
                  Live
                </span>
              )}
            </Heading>
            <Text className="text-xs text-ui-fg-subtle mt-0.5">
              Purchase orders, item receipts, and vendor bills, including add,
              modify, void, and delete operations.
            </Text>
          </div>
          <Button
            variant="secondary"
            size="small"
            onClick={() => fetchRows()}
            isLoading={loading}
          >
            <ArrowPath className="mr-1" />
            Refresh
          </Button>
        </div>

        {/* Summary badges */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {(
            [
              { key: "waiting", label: "Waiting", color: "orange" },
              { key: "processing", label: "Processing", color: "blue" },
              { key: "submitted", label: "Submitted", color: "blue" },
              { key: "completed", label: "Completed", color: "green" },
              { key: "error", label: "Error", color: "red" },
              { key: "synced", label: "Synced", color: "green" },
              { key: "failed_permanent", label: "Failed", color: "red" },
            ] as { key: keyof Counts; label: string; color: BadgeColor }[]
          ).map(({ key, label, color }) => {
            const count = counts[key] ?? 0;
            if (count === 0) return null;
            return (
              <Badge key={key} color={color} size="xsmall">
                {label} {count}
              </Badge>
            );
          })}
          {Object.values(counts).every((v) => v === 0) && (
            <span className="text-xs text-ui-fg-muted">
              No operations recorded yet
            </span>
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <input
            type="text"
            placeholder="Search PO / receipt / bill / vendor / QB ref / error…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(0);
            }}
            className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base w-52 placeholder:text-ui-fg-muted"
          />
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(0);
            }}
            className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base"
          >
            <option value="all">All Statuses</option>
            <option value="waiting">Waiting</option>
            <option value="processing">Processing</option>
            <option value="submitted">Submitted</option>
            <option value="completed">Completed</option>
            <option value="error">Error</option>
            <option value="synced">Synced</option>
            <option value="failed_permanent">Failed</option>
          </select>
          <span className="text-xs text-ui-fg-muted ml-auto">
            {total} total operation{total !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Table */}
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Text className="text-sm text-ui-fg-subtle">
              No pipeline operations found.
            </Text>
            <Text className="text-xs text-ui-fg-muted mt-1">
              Operations appear here when POs or item receipts sync to
              QuickBooks.
            </Text>
          </div>
        ) : (
          <div className="overflow-x-auto rounded border border-ui-border-base">
            <table className="w-full text-xs">
              <thead className="bg-ui-bg-subtle border-b border-ui-border-base">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle w-10">
                    #
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    Step
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    PO / Receipt / Bill
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    QB Ref #
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    Vendor
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    Status
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    QB ListID
                  </th>
                  <th className="px-3 py-2 text-center font-semibold text-ui-fg-subtle">
                    Retries
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    Created
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    Updated
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <PipelinePoRow
                    key={row.id}
                    row={row}
                    onRetry={handleRetry}
                    onMarkFixed={handleMarkFixed}
                    retrying={retryingId === row.id}
                    markingFixed={markingFixedId === row.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <PipelinePagination page={page} total={total} onPageChange={setPage} />
      </div>
    </Container>
  );
};
