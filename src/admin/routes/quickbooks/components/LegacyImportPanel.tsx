import { Container, Heading, Text, Button, toast } from "@medusajs/ui";
import { useState, useEffect } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LegacySoRecord {
  qb_txn_id: string;
  qb_ref_number: string;
  qb_customer_name: string;
  txn_date: string | null;
  amount: number | string;
  balance_remaining: number | string;
  status: string;
}

interface StagedPaymentRecord {
  id: number;
  qb_txn_id: string;
  qb_ref_number: string;
  qb_customer_list_id: string;
  qb_customer_name: string;
  medusa_customer_id: string | null;
  medusa_customer_email: string | null;
  amount_cents: number;
  txn_date: string | null;
  method: string;
  year: number;
  status: "pending" | "applied" | "no_match";
  applied_payment_id: string | null;
  fetched_at: string;
  applied_at: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (v: number | string) =>
  typeof v === "number"
    ? `$${v.toFixed(2)}`
    : `$${parseFloat(String(v) || "0").toFixed(2)}`;

const fmtCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const fmtDate = (d: string | null) => {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return d;
  }
};

// ── Known open SO ref numbers (from QB report 2026-03-31) ────────────────────
const KNOWN_SO_REFS = [
  "3682",
  "4620",
  "4910",
  "5126",
  "5695",
  "5731",
  "5891",
  "5923",
  "5956",
  "6006",
  "6020",
  "6025",
  "6058",
  "6059",
  "6061",
  "6062",
  "6068",
  "6082",
  "6088",
  "6118",
  "6131",
  "6151",
  "6198",
  "6205",
  "6224",
  "6238",
  "6239",
];

type RowStatus = "pending" | "loading" | "done" | "error";

interface SoRow {
  refNumber: string;
  status: RowStatus;
  txnId?: string;
  customer?: string;
  date?: string;
  amount?: number;
  error?: string;
}

// ── Tab: Sales Orders ─────────────────────────────────────────────────────────

function SalesOrdersTab() {
  const [rows, setRows] = useState<SoRow[]>(() =>
    KNOWN_SO_REFS.map((ref) => ({
      refNumber: ref,
      status: "pending" as RowStatus,
    }))
  );

  // On mount, load existing DB records and mark them as done
  useEffect(() => {
    fetch("/admin/quickbooks/import/sales-orders", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.records?.length) return;
        const byRef = new Map<string, LegacySoRecord>(
          data.records.map((r: LegacySoRecord) => [r.qb_ref_number, r])
        );
        setRows((prev) =>
          prev.map((row) => {
            const existing = byRef.get(row.refNumber);
            if (!existing) return row;
            return {
              ...row,
              status: "done",
              txnId: existing.qb_txn_id,
              customer: existing.qb_customer_name,
              date: existing.txn_date ?? undefined,
              amount: parseFloat(String(existing.amount)) || 0,
            };
          })
        );
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (refNumber: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.refNumber === refNumber ? { ...r, status: "loading" } : r
      )
    );
    try {
      const res = await fetch("/admin/quickbooks/import/sales-orders", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refNumber }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setRows((prev) =>
          prev.map((r) =>
            r.refNumber === refNumber
              ? { ...r, status: "error", error: data.error || "Unknown error" }
              : r
          )
        );
        toast.error(`SO #${refNumber} failed`, { description: data.error });
        return;
      }
      setRows((prev) =>
        prev.map((r) =>
          r.refNumber === refNumber
            ? {
                ...r,
                status: "done",
                txnId: data.record.txnId,
                customer: data.record.customer,
                date: data.record.date,
                amount: data.record.amount,
              }
            : r
        )
      );
    } catch (err: any) {
      setRows((prev) =>
        prev.map((r) =>
          r.refNumber === refNumber
            ? { ...r, status: "error", error: err.message }
            : r
        )
      );
      toast.error(`SO #${refNumber} error`, { description: err.message });
    }
  };

  const doneCount = rows.filter((r) => r.status === "done").length;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <Text className="text-xs text-ui-fg-subtle">
          Reference data only — no orders are created automatically. Click
          Submit on each row to fetch from QB. TxnID and customer info will fill
          in once fetched.
        </Text>
        <span className="text-xs text-ui-fg-muted ml-4 shrink-0">
          {doneCount}/{rows.length} fetched
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-ui-bg-subtle">
              <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                SO#
              </th>
              <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                Customer
              </th>
              <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                TxnID
              </th>
              <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                Date
              </th>
              <th className="text-right px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                Amount
              </th>
              <th className="px-2 py-1.5 border-b border-ui-border-base"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.refNumber}
                className="border-b border-ui-border-base hover:bg-ui-bg-subtle"
              >
                <td className="px-2 py-1.5 font-mono font-medium text-ui-fg-base">
                  {row.refNumber}
                </td>
                <td className="px-2 py-1.5 text-ui-fg-base">
                  {row.customer || (
                    <span className="text-ui-fg-muted italic">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono text-xs text-ui-fg-subtle select-all">
                  {row.txnId || <span className="text-ui-fg-muted">—</span>}
                </td>
                <td className="px-2 py-1.5 text-ui-fg-subtle">
                  {row.date ? (
                    fmtDate(row.date)
                  ) : (
                    <span className="text-ui-fg-muted">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right text-ui-fg-base">
                  {row.amount != null ? (
                    fmt(row.amount)
                  ) : (
                    <span className="text-ui-fg-muted">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {row.status === "done" ? (
                    <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-green-50 text-green-700 border border-green-200">
                      ✓ done
                    </span>
                  ) : row.status === "error" ? (
                    <span
                      className="inline-block rounded-full px-2 py-0.5 text-xs bg-red-50 text-red-700 border border-red-200"
                      title={row.error}
                    >
                      error
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => handleSubmit(row.refNumber)}
                      isLoading={row.status === "loading"}
                      disabled={row.status === "loading"}
                    >
                      {row.status === "loading" ? "..." : "Submit"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Tab: Unapplied Payments ───────────────────────────────────────────────────

const PAYMENTS_PAGE_SIZE = 20;
const CURRENT_YEAR = new Date().getFullYear();

function PaymentsTab() {
  const [syncLoading, setSyncLoading] = useState(false);
  const [records, setRecords] = useState<StagedPaymentRecord[]>([]);
  const [loadingDb, setLoadingDb] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [selectedYear, setSelectedYear] = useState<number>(CURRENT_YEAR);
  const [availableYears, setAvailableYears] = useState<number[]>([
    CURRENT_YEAR - 2,
    CURRENT_YEAR - 1,
    CURRENT_YEAR,
  ]);

  const loadFromDb = async (year: number) => {
    setLoadingDb(true);
    try {
      const r = await fetch(`/admin/quickbooks/import/payments?year=${year}`, {
        credentials: "include",
      });
      const data = await r.json();
      if (!r.ok || !data.success)
        throw new Error(data.error || "Failed to load");
      setRecords(data.records ?? []);
      setPage(0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error("Load error", { description: msg });
    } finally {
      setLoadingDb(false);
    }
  };

  useEffect(() => {
    loadFromDb(selectedYear);
  }, [selectedYear]);

  const selectYear = (year: number) => {
    setSelectedYear(year);
    setPage(0);
  };

  const addEarlierYear = () => {
    const earliest = Math.min(...availableYears);
    setAvailableYears((prev) => [earliest - 1, ...prev]);
  };

  const handleSync = async () => {
    setSyncLoading(true);
    try {
      const r = await fetch("/admin/quickbooks/import/payments", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", year: selectedYear }),
      });
      const data = await r.json();
      if (!r.ok || !data.success) throw new Error(data.error || "Sync failed");
      setRecords(data.records ?? []);
      setPage(0);
      toast.success(`Synced ${selectedYear}`, {
        description: `${data.pending} pending · ${data.applied} applied · ${data.no_match} no match`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error("Sync error", { description: msg });
    } finally {
      setSyncLoading(false);
    }
  };

  const handleApply = async (rec: StagedPaymentRecord) => {
    setApplyingId(rec.qb_txn_id);
    try {
      const r = await fetch("/admin/quickbooks/import/payments", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          txn_id: rec.qb_txn_id,
          year: selectedYear,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.success) throw new Error(data.error || "Apply failed");
      toast.success("Payment applied", {
        description: `${rec.qb_customer_name} — ${fmtCents(rec.amount_cents)}`,
      });
      setRecords((prev) =>
        prev.map((p) =>
          p.qb_txn_id === rec.qb_txn_id
            ? {
                ...p,
                status: "applied",
                applied_payment_id: data.payment_id,
                applied_at: new Date().toISOString(),
              }
            : p
        )
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error("Apply error", { description: msg });
    } finally {
      setApplyingId(null);
    }
  };

  const pending = records.filter((r) => r.status === "pending").length;
  const applied = records.filter((r) => r.status === "applied").length;
  const noMatch = records.filter((r) => r.status === "no_match").length;
  const totalPages = Math.ceil(records.length / PAYMENTS_PAGE_SIZE);
  const pageRecords = records.slice(
    page * PAYMENTS_PAGE_SIZE,
    (page + 1) * PAYMENTS_PAGE_SIZE
  );
  const busy = syncLoading || loadingDb || applyingId !== null;

  return (
    <div>
      {/* Year selector */}
      <div className="flex items-center gap-1 mb-3">
        <Text className="text-xs text-ui-fg-subtle mr-2">Year:</Text>
        {availableYears.map((y) => (
          <button
            key={y}
            onClick={() => selectYear(y)}
            className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors ${
              selectedYear === y
                ? "bg-ui-bg-interactive text-ui-fg-on-color border-ui-bg-interactive"
                : "bg-ui-bg-base text-ui-fg-subtle border-ui-border-base hover:bg-ui-bg-subtle"
            }`}
            disabled={busy}
          >
            {y}
          </button>
        ))}
        <button
          onClick={addEarlierYear}
          className="px-2 py-1 text-xs font-medium rounded border border-ui-border-base bg-ui-bg-base text-ui-fg-muted hover:bg-ui-bg-subtle transition-colors"
          disabled={busy}
          title="Add earlier year"
        >
          +
        </button>
      </div>

      {/* Header bar */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-4">
          {records.length > 0 && (
            <>
              {pending > 0 && (
                <span className="text-xs text-amber-700 font-medium">
                  ⏳ {pending} pending
                </span>
              )}
              {applied > 0 && (
                <span className="text-xs text-green-700 font-medium">
                  ✓ {applied} applied
                </span>
              )}
              {noMatch > 0 && (
                <span className="text-xs text-ui-fg-muted">
                  ⊘ {noMatch} no match
                </span>
              )}
            </>
          )}
          {records.length === 0 && !loadingDb && (
            <Text className="text-xs text-ui-fg-muted italic">
              No staging records for {selectedYear}. Click "Sync from QB" to
              fetch.
            </Text>
          )}
        </div>
        <Button
          variant="secondary"
          size="small"
          onClick={handleSync}
          isLoading={syncLoading}
          disabled={busy}
        >
          {syncLoading ? "Querying QB..." : "Sync from QB"}
        </Button>
      </div>

      {records.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-ui-bg-subtle">
                <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                  Customer (QB)
                </th>
                <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                  Medusa Match
                </th>
                <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                  TxnID
                </th>
                <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                  Ref#
                </th>
                <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                  Date
                </th>
                <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                  Method
                </th>
                <th className="text-right px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                  Amount
                </th>
                <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">
                  Status
                </th>
                <th className="px-2 py-1.5 border-b border-ui-border-base"></th>
              </tr>
            </thead>
            <tbody>
              {pageRecords.map((p) => (
                <tr
                  key={p.qb_txn_id}
                  className="border-b border-ui-border-base hover:bg-ui-bg-subtle"
                >
                  <td className="px-2 py-1.5 text-ui-fg-base">
                    {p.qb_customer_name}
                  </td>
                  <td className="px-2 py-1.5">
                    {p.medusa_customer_id ? (
                      <span className="text-green-700">
                        {p.medusa_customer_email || p.medusa_customer_id}
                      </span>
                    ) : (
                      <span className="text-ui-fg-muted">No match</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-ui-fg-subtle">
                    {p.qb_txn_id || "—"}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-ui-fg-subtle">
                    {p.qb_ref_number || "—"}
                  </td>
                  <td className="px-2 py-1.5 text-ui-fg-subtle">
                    {fmtDate(p.txn_date)}
                  </td>
                  <td className="px-2 py-1.5 text-ui-fg-subtle capitalize">
                    {p.method}
                  </td>
                  <td className="px-2 py-1.5 text-right font-medium text-ui-fg-base">
                    {fmtCents(p.amount_cents)}
                  </td>
                  <td className="px-2 py-1.5">
                    {p.status === "applied" ? (
                      <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-green-50 text-green-700 border border-green-200">
                        Applied
                      </span>
                    ) : p.status === "no_match" ? (
                      <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-ui-bg-subtle text-ui-fg-muted border border-ui-border-base">
                        No match
                      </span>
                    ) : (
                      <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-amber-50 text-amber-700 border border-amber-200">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {p.status === "pending" && p.medusa_customer_id && (
                      <Button
                        variant="primary"
                        size="small"
                        onClick={() => handleApply(p)}
                        isLoading={applyingId === p.qb_txn_id}
                        disabled={busy}
                      >
                        Apply
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-2 px-1">
              <Text className="text-xs text-ui-fg-muted">
                Page {page + 1} of {totalPages} ({records.length} total)
              </Text>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  ← Prev
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() =>
                    setPage((p) => Math.min(totalPages - 1, p + 1))
                  }
                  disabled={page >= totalPages - 1}
                >
                  Next →
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

type Tab = "sales-orders" | "payments";

export function LegacyImportPanel() {
  const [activeTab, setActiveTab] = useState<Tab>("sales-orders");

  const tabClass = (tab: Tab) =>
    `px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors ${
      activeTab === tab
        ? "bg-ui-bg-interactive text-ui-fg-on-color"
        : "text-ui-fg-subtle hover:text-ui-fg-base hover:bg-ui-bg-subtle"
    }`;

  return (
    <Container>
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <Heading level="h3" className="text-sm font-medium">
            🗂️ Legacy QB Data Import
          </Heading>
          <div className="flex items-center gap-1 bg-ui-bg-subtle rounded-md p-0.5">
            <button
              className={tabClass("sales-orders")}
              onClick={() => setActiveTab("sales-orders")}
            >
              Open Sales Orders
            </button>
            <button
              className={tabClass("payments")}
              onClick={() => setActiveTab("payments")}
            >
              Unapplied Payments
            </button>
          </div>
        </div>

        {activeTab === "sales-orders" && <SalesOrdersTab />}
        {activeTab === "payments" && <PaymentsTab />}
      </div>
    </Container>
  );
}
