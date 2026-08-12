import { ArrowPath } from "@medusajs/icons";
import { Container, Heading, Text, Button, Badge } from "@medusajs/ui";
import {
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type PipelineStatus =
  | "pending"
  | "submitted"
  | "processing"
  | "confirmed"
  | "failed"
  | "fixed"
  | "skipped"
  | "waiting"
  | "manual";

interface PipelineRow {
  seq: number;
  id: string;
  order_id: string | null;
  reference_id: string | null;
  reference_type: string | null;
  step: string;
  status: PipelineStatus;
  depends_on: string | null;
  depends_on_step: string | null;
  depends_on_status: string | null;
  depends_on_medusa_ref: string | null;
  // apply_payment dual-dependency: SOURCE (Payment or Credit Memo) + TARGET (Invoice).
  // Derived from documents (cpay + payment_application), independent of depends_on.
  source_dep_step: string | null;
  source_dep_status: string | null;
  source_dep_ref: string | null;
  target_dep_step: string | null;
  target_dep_status: string | null;
  target_dep_ref: string | null;
  bridge_op_id: string | null;
  retry_count: number;
  qb_txn_id: string | null;
  qb_ref_number: string | null;
  medusa_ref_number: string | null;
  error: string | null;
  created_at: string;
  updated_at: string | null;
  submitted_at: string | null;
  confirmed_at: string | null;
  failed_at: string | null;
  order_display_id: number | null;
}

interface PipelineCounts {
  pending?: number;
  submitted?: number;
  processing?: number;
  confirmed?: number;
  failed?: number;
  fixed?: number;
  skipped?: number;
  waiting?: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const STEP_LABELS: Record<string, string> = {
  estimate: "Estimate",
  estimate_mod: "Estimate Edit",
  sales_order: "Sales Order",
  sales_order_mod: "Sales Order Edit",
  sales_receipt: "Sales Receipt",
  sales_receipt_update: "Sales Receipt Edit",
  invoice: "Invoice",
  invoice_update: "Invoice Edit",
  payment: "Payment",
  payment_method_change: "Payment Method Change",
  payment_txndate_change: "Payment Date Change",
  apply_payment: "Apply Payment",
  credit_memo: "Credit Memo",
  credit_memo_mod: "Credit Memo Edit",
  write_check: "Write Check",
  refund_payment: "Refund Payment",
  // Ajuste de inventario por unidades defectuosas de un credit memo. Vive en el
  // tab Sales a propósito, junto al credit memo que lo genera: la pregunta que
  // alguien se hace frente a un problema es "¿este credit memo llegó entero a
  // QuickBooks?", y las dos mitades comparten reference_id y CM-####.
  cm_damage_adjustment: "Defective Adjustment",
  cm_damage_adjustment_mod: "Defective Adjustment Edit",
  void_cm_damage_adjustment: "Defective Adjustment Void",
};

const STEP_ICONS: Record<string, string> = {
  estimate: "📋",
  estimate_mod: "✏️",
  sales_order: "🧾",
  sales_order_mod: "✏️",
  sales_receipt: "🏷️",
  sales_receipt_update: "✏️",
  invoice: "📄",
  invoice_update: "✏️",
  payment: "💳",
  payment_method_change: "✏️",
  payment_txndate_change: "✏️",
  apply_payment: "🔗",
  credit_memo: "↩️",
  credit_memo_mod: "✏️",
  write_check: "✍️",
  refund_payment: "🔄",
  cm_damage_adjustment: "📉",
  cm_damage_adjustment_mod: "✏️",
  void_cm_damage_adjustment: "🚫",
};

const REF_TYPE_LABELS: Record<string, string> = {
  order: "Order",
  credit_memo: "Return",
  pos_invoice: "Invoice",
};

// ─── Status Badge ─────────────────────────────────────────────────────────────

type BadgeColor = "orange" | "blue" | "green" | "red" | "grey";

function StatusBadge({ status }: { status: PipelineStatus }) {
  const map: Record<PipelineStatus, { color: BadgeColor; label: string }> = {
    pending: { color: "orange", label: "Pending" },
    submitted: { color: "blue", label: "Submitted" },
    processing: { color: "blue", label: "Submitting" },
    confirmed: { color: "green", label: "Confirmed" },
    failed: { color: "red", label: "Failed" },
    fixed: { color: "grey", label: "Fixed" },
    skipped: { color: "grey", label: "Skipped" },
    waiting: { color: "blue", label: "Waiting" },
    manual: { color: "grey", label: "Manual" },
  };
  const s = map[status] ?? { color: "grey" as BadgeColor, label: status };
  return (
    <Badge color={s.color} size="xsmall">
      {s.label}
    </Badge>
  );
}

// ─── Pipeline date formatter ──────────────────────────────────────────────────
// < 24 h → time only ("10:32 AM")
// ≥ 24 h → date on top + time below ("Mar 28 / 10:32 AM")

function formatPipelineDate(iso: string | null): ReactNode {
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

// ─── Row component ────────────────────────────────────────────────────────────

function PipelineRow({
  row,
  onRetry,
  onMarkFixed,
  retrying,
  markingFixed,
}: {
  row: PipelineRow;
  onRetry: (id: string) => void;
  onMarkFixed: (id: string) => void;
  retrying: boolean;
  markingFixed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const icon = STEP_ICONS[row.step] ?? "📎";
  const label = STEP_LABELS[row.step] ?? row.step;
  const refLabel = row.reference_type
    ? (REF_TYPE_LABELS[row.reference_type] ?? row.reference_type)
    : null;
  const medusaRef = row.medusa_ref_number ?? null;
  const qbRef = row.qb_ref_number ?? null;

  return (
    <>
      <tr
        className={`border-b border-ui-border-base text-xs transition-colors ${
          row.status === "failed"
            ? "bg-red-50/5"
            : row.status === "pending"
              ? "bg-yellow-50/5"
              : row.status === "submitted" || row.status === "processing"
                ? "bg-blue-50/5"
                : row.status === "waiting"
                  ? "bg-purple-50/5"
                  : ""
        }`}
      >
        {/* Seq ID */}
        <td className="px-3 py-2 whitespace-nowrap">
          <span className="font-mono text-[11px] text-ui-fg-muted">
            #{row.seq}
          </span>
        </td>

        {/* Step */}
        <td className="px-3 py-2 whitespace-nowrap">
          <span className="flex items-center gap-1.5">
            <span>{icon}</span>
            <span className="font-medium text-ui-fg-base">{label}</span>
          </span>
        </td>

        {/* Order */}
        <td className="px-3 py-2 whitespace-nowrap">
          {row.order_display_id ? (
            <span className="font-mono text-[11px] text-ui-fg-subtle">
              {row.order_display_id}
            </span>
          ) : (
            <span className="text-ui-fg-muted">—</span>
          )}
        </td>

        {/* Medusa Ref */}
        <td className="px-3 py-2 whitespace-nowrap">
          {medusaRef ? (
            <span className="font-mono font-semibold text-ui-fg-base">
              {medusaRef}
            </span>
          ) : refLabel ? (
            <span className="text-[10px] text-ui-fg-muted">{refLabel}</span>
          ) : (
            <span className="text-ui-fg-muted">—</span>
          )}
        </td>

        {/* QB Ref — payments have no user-visible QB ref number, show Medusa ref instead */}
        <td className="px-3 py-2 whitespace-nowrap">
          {qbRef ? (
            <span className="font-mono text-xs text-violet-600 font-semibold">
              {qbRef}
            </span>
          ) : (row.step === "payment" || row.step === "apply_payment") &&
            medusaRef ? (
            <span className="font-mono text-xs text-ui-fg-base font-semibold">
              {medusaRef}
            </span>
          ) : row.status === "skipped" || row.step === "refund_payment" ? (
            <span className="text-ui-fg-muted">—</span>
          ) : (
            <span className="text-ui-fg-muted text-[10px]">pending…</span>
          )}
        </td>

        {/* Status */}
        <td className="px-3 py-2 whitespace-nowrap">
          <StatusBadge status={row.status} />
        </td>

        {/* Depends on */}
        <td className="px-3 py-2 text-ui-fg-subtle">
          <span className="flex flex-col gap-0.5">
            {/* apply_payment rows always render two facts: SOURCE + TARGET.
                Source is where the money comes from (Payment or Credit Memo),
                Target is where it was applied (Invoice). Derived from documents,
                so they show even when the gating depends_on points to only one. */}
            {row.step === "apply_payment" ? (
              <>
                {row.source_dep_step ? (
                  <span className="flex items-center gap-1">
                    <span className="text-ui-fg-muted text-[11px]">
                      {STEP_LABELS[row.source_dep_step] ?? row.source_dep_step}
                    </span>
                    {row.source_dep_ref && (
                      <span className="font-mono font-semibold text-[11px] text-ui-fg-base">
                        {row.source_dep_ref}
                      </span>
                    )}
                    {row.source_dep_status === "confirmed" ? (
                      <span className="text-green-600 text-[10px]">✓</span>
                    ) : (
                      <span className="text-yellow-600 text-[10px]">⏳</span>
                    )}
                  </span>
                ) : null}
                {row.target_dep_step ? (
                  <span className="flex items-center gap-1">
                    <span className="text-ui-fg-muted text-[11px]">
                      {STEP_LABELS[row.target_dep_step] ?? row.target_dep_step}
                    </span>
                    {row.target_dep_ref && (
                      <span className="font-mono font-semibold text-[11px] text-ui-fg-base">
                        {row.target_dep_ref}
                      </span>
                    )}
                    {row.target_dep_status === "confirmed" ? (
                      <span className="text-green-600 text-[10px]">✓</span>
                    ) : (
                      <span className="text-yellow-600 text-[10px]">⏳</span>
                    )}
                  </span>
                ) : null}
              </>
            ) : row.depends_on_step ? (
              <span className="flex items-center gap-1">
                <span className="text-ui-fg-muted text-[11px]">
                  {STEP_LABELS[row.depends_on_step] ?? row.depends_on_step}
                </span>
                {row.depends_on_medusa_ref && (
                  <span className="font-mono font-semibold text-[11px] text-ui-fg-base">
                    {row.depends_on_medusa_ref}
                  </span>
                )}
                {row.depends_on_status === "confirmed" ? (
                  <span className="text-green-600 text-[10px]">✓</span>
                ) : (
                  <span className="text-yellow-600 text-[10px]">⏳</span>
                )}
              </span>
            ) : null}
            {(row.step === "sales_order" || row.step === "estimate") &&
            row.status === "waiting" &&
            !row.depends_on_step ? (
              <span className="flex items-center gap-1">
                <span className="text-[10px]">🕐</span>
                <span className="text-ui-fg-muted text-[11px] italic">
                  1 Hour Window
                </span>
              </span>
            ) : row.status === "manual" ? (
              <span className="flex items-center gap-1">
                <span className="text-[10px]">✋</span>
                <span className="text-ui-fg-muted text-[11px] italic">
                  Manual Entry
                </span>
              </span>
            ) : null}
            {!row.depends_on_step &&
              !(
                row.step === "apply_payment" &&
                (row.source_dep_step || row.target_dep_step)
              ) &&
              !(
                (row.step === "sales_order" || row.step === "estimate") &&
                row.status === "waiting"
              ) && <span className="text-ui-fg-muted">—</span>}
          </span>
        </td>

        {/* QB TxnID */}
        <td className="px-3 py-2 font-mono text-ui-fg-subtle">
          {row.qb_txn_id ? (
            <span className="text-green-700 font-semibold">
              {row.qb_txn_id}
            </span>
          ) : row.bridge_op_id ? (
            <span className="text-blue-600 text-[10px]">
              op:{row.bridge_op_id.slice(-6)}
            </span>
          ) : (
            <span className="text-ui-fg-muted">—</span>
          )}
        </td>

        {/* Retries */}
        <td className="px-3 py-2 text-center text-ui-fg-muted">
          {row.retry_count > 0 ? (
            <span className="text-orange-600 font-semibold">
              {row.retry_count}
            </span>
          ) : (
            "0"
          )}
        </td>

        {/* Created */}
        <td className="px-3 py-2 text-ui-fg-muted">
          {formatPipelineDate(row.created_at)}
        </td>

        {/* Updated */}
        <td className="px-3 py-2">
          {(() => {
            const updated =
              row.status === "failed"
                ? row.failed_at
                : row.status === "confirmed"
                  ? row.confirmed_at
                  : (row.submitted_at ?? row.updated_at);
            if (!updated) return <span className="text-ui-fg-muted">—</span>;
            return (
              <span
                className={
                  row.status === "confirmed"
                    ? "text-green-500"
                    : row.status === "failed"
                      ? "text-red-400"
                      : "text-ui-fg-subtle"
                }
              >
                {formatPipelineDate(updated)}
              </span>
            );
          })()}
        </td>

        {/* Actions */}
        <td className="px-3 py-2">
          <div className="flex items-center gap-1">
            {row.error && row.status !== "skipped" && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="text-[10px] text-red-600 hover:underline"
              >
                {expanded ? "▲ hide" : "▼ error"}
              </button>
            )}
            {(row.status === "failed" || row.status === "waiting") && (
              <button
                onClick={() => onRetry(row.id)}
                disabled={retrying}
                className="ml-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-ui-button-neutral hover:bg-ui-button-neutral-hover text-ui-fg-base border border-ui-border-base disabled:opacity-50"
              >
                {retrying ? "…" : "Retry"}
              </button>
            )}
            {(row.status === "failed" || row.status === "manual") && (
              <button
                onClick={() => {
                  if (
                    confirm(
                      "Mark this row as Fixed? Use this only if you resolved the issue manually in QuickBooks Desktop."
                    )
                  ) {
                    onMarkFixed(row.id);
                  }
                }}
                disabled={markingFixed}
                title="Acknowledge — already resolved in QuickBooks"
                className="ml-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-ui-button-neutral hover:bg-ui-button-neutral-hover text-ui-fg-base border border-ui-border-base disabled:opacity-50"
              >
                {markingFixed ? "…" : "Mark Fixed"}
              </button>
            )}
            {row.status === "manual" && (
              <span className="text-[10px] text-ui-fg-muted italic">
                Use QB Tools
              </span>
            )}
          </div>
        </td>
      </tr>

      {/* Error expansion row */}
      {expanded && row.error && (
        <tr className="bg-red-50/5 border-b border-ui-border-base">
          <td colSpan={11} className="px-4 py-2">
            <pre className="text-[10px] text-red-400 whitespace-pre-wrap break-all font-mono">
              {row.error}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function PipelineTable() {
  const PAGE_SIZE = 12;
  const [rows, setRows] = useState<PipelineRow[]>([]);
  const [counts, setCounts] = useState<PipelineCounts>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [stepFilter, setStepFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"created_at" | "updated_at">(
    "created_at"
  );
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPipeline = useCallback(
    async (silent = false, pg = page) => {
      if (!silent) setLoading(true);
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(pg * PAGE_SIZE),
        });
        if (statusFilter !== "all") params.set("status", statusFilter);
        if (stepFilter !== "all") params.set("step", stepFilter);
        if (searchQuery.trim()) params.set("search", searchQuery.trim());
        params.set("sort_by", sortBy);

        const res = await fetch(`/admin/quickbooks/pipeline?${params}`, {
          credentials: "include",
        });
        if (!res.ok) return;
        const data = await res.json();
        setRows(data.pipeline ?? []);
        setCounts(data.counts ?? {});
        setTotal(data.pagination?.total ?? 0);
      } catch {
        /* non-blocking */
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [statusFilter, stepFilter, sortBy, searchQuery, page]
  );

  // Initial load + filter changes
  useEffect(() => {
    fetchPipeline();
  }, [fetchPipeline]);

  // Auto-refresh every 10s while pending/submitted rows exist
  useEffect(() => {
    const hasPending =
      (counts.pending ?? 0) > 0 ||
      (counts.submitted ?? 0) > 0 ||
      (counts.processing ?? 0) > 0;
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (hasPending) {
      intervalRef.current = setInterval(() => fetchPipeline(true), 10_000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [counts.pending, counts.submitted, counts.processing, fetchPipeline]);

  const handleRetry = async (id: string) => {
    setRetryingId(id);
    try {
      const res = await fetch(
        `/admin/quickbooks/pipeline?action=retry&id=${id}`,
        {
          method: "POST",
          credentials: "include",
        }
      );
      if (res.ok) await fetchPipeline(true);
    } catch {
      /* non-blocking */
    } finally {
      setRetryingId(null);
    }
  };

  const [markingFixedId, setMarkingFixedId] = useState<string | null>(null);

  const handleMarkFixed = async (id: string) => {
    setMarkingFixedId(id);
    // Optimistic update so the badge reflects the change immediately
    setCounts((prev) => ({
      ...prev,
      failed: Math.max(0, (prev.failed ?? 0) - 1),
      fixed: (prev.fixed ?? 0) + 1,
    }));
    try {
      const res = await fetch(
        `/admin/quickbooks/pipeline?action=mark-fixed&id=${id}`,
        {
          method: "POST",
          credentials: "include",
        }
      );
      await fetchPipeline(true);
      if (!res.ok) return;
    } catch {
      await fetchPipeline(true);
    } finally {
      setMarkingFixedId(null);
    }
  };

  const hasPending = (counts.pending ?? 0) > 0 || (counts.submitted ?? 0) > 0;

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
              ⚡ QB Sales Pipeline
              {hasPending && (
                <span className="inline-flex items-center gap-1 text-[10px] font-normal text-blue-600 animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
                  Live
                </span>
              )}
            </Heading>
            <Text className="text-xs text-ui-fg-subtle mt-0.5">
              Real-time queue of QuickBooks document operations — auto-refreshes
              while active
            </Text>
          </div>
          <Button
            variant="secondary"
            size="small"
            onClick={() => fetchPipeline()}
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
              {
                key: "waiting",
                label: "Waiting",
                color: "purple",
                tip: "Blocked by a dependency (e.g. customer sync) — auto-resumes when ready",
              },
              {
                key: "pending",
                label: "Pending",
                color: "orange",
                tip: "Queued for the consolidator's next dispatch pass",
              },
              {
                key: "processing",
                label: "Submitting",
                color: "blue",
                tip: "Consolidator claimed the row and is sending it to the QB bridge (seconds)",
              },
              {
                key: "submitted",
                label: "Submitted",
                color: "blue",
                tip: "Bridge accepted the request — waiting for QuickBooks Desktop response (minutes)",
              },
              {
                key: "confirmed",
                label: "Confirmed",
                color: "green",
                tip: "QuickBooks accepted the document",
              },
              {
                key: "failed",
                label: "Failed",
                color: "red",
                tip: "Bridge or QB returned an error — retryable",
              },
              {
                key: "fixed",
                label: "Fixed",
                color: "grey",
                tip: "Manually acknowledged — resolved outside the pipeline",
              },
              {
                key: "skipped",
                label: "Skipped",
                color: "grey",
                tip: "Intentional no-op (e.g. nothing to sync)",
              },
            ] as {
              key: string;
              label: string;
              color: BadgeColor;
              tip: string;
            }[]
          ).map(({ key, label, color, tip }) => {
            const count = counts[key as keyof PipelineCounts] ?? 0;
            if (count === 0) return null;
            return (
              <span key={key} title={tip}>
                <Badge color={color} size="xsmall">
                  {label} {count}
                </Badge>
              </span>
            );
          })}
          {Object.values(counts).every((v) => !v || v === 0) && (
            <span className="text-xs text-ui-fg-muted">
              No operations recorded yet
            </span>
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <input
            type="text"
            placeholder="Search ref # or QB ref…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(0);
            }}
            className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base w-48 placeholder:text-ui-fg-muted"
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
            <option value="pending">Pending</option>
            <option value="processing">Submitting</option>
            <option value="submitted">Submitted</option>
            <option value="confirmed">Confirmed</option>
            <option value="failed">Failed</option>
            <option value="fixed">Fixed</option>
            <option value="skipped">Skipped</option>
          </select>
          <select
            value={stepFilter}
            onChange={(e) => {
              setStepFilter(e.target.value);
              setPage(0);
            }}
            className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base"
          >
            <option value="all">All Steps</option>
            {/* Derivado de STEP_LABELS a propósito: esta lista era una SEGUNDA
                copia hard-codeada de los mismos steps, y una lista duplicada de
                steps ya hizo que un badge contara filas que su propia pestaña no
                mostraba. Un step nuevo se agrega en UN lugar. */}
            {Object.entries(STEP_LABELS).map(([step, label]) => (
              <option key={step} value={step}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value as "created_at" | "updated_at");
              setPage(0);
            }}
            className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base"
          >
            <option value="created_at">Sort: Created At</option>
            <option value="updated_at">Sort: Updated At</option>
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
              Operations appear here when orders sync to QuickBooks.
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
                    Order
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    Medusa Ref
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    QB Ref
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    Status
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    Depends On
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">
                    QB TxnID
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
                  <PipelineRow
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

        {/* Pagination */}
        {Math.ceil(total / PAGE_SIZE) > 1 && (
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-ui-border-base">
            <span className="text-xs text-ui-fg-muted">
              Page {page + 1} of {Math.ceil(total / PAGE_SIZE)}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => {
                  setPage((p) => p - 1);
                  fetchPipeline(false, page - 1);
                }}
                className="text-xs px-3 py-1 rounded border border-ui-border-base disabled:opacity-40 hover:bg-ui-bg-subtle"
              >
                ← Prev
              </button>
              <button
                disabled={page >= Math.ceil(total / PAGE_SIZE) - 1}
                onClick={() => {
                  setPage((p) => p + 1);
                  fetchPipeline(false, page + 1);
                }}
                className="text-xs px-3 py-1 rounded border border-ui-border-base disabled:opacity-40 hover:bg-ui-bg-subtle"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </div>
    </Container>
  );
}
