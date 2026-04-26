import { ArrowPath } from "@medusajs/icons";
import { Container, Heading, Text, Button, Badge } from "@medusajs/ui";
import { useEffect, useState, useCallback } from "react";

// ─── Flush Button ─────────────────────────────────────────────────────────────

type FlushTarget = "both" | "bridge" | "medusa";

const FLUSH_CONFIG: Record<
  FlushTarget,
  { label: string; confirm: string; params: string; color: string }
> = {
  both: {
    label: "Flush All",
    confirm:
      "This will flush BOTH the bridge queue and the Medusa pipeline table. All pending/submitted operations will be lost. Continue?",
    params: "",
    color: "bg-red-600 hover:bg-red-700 text-white border-red-700",
  },
  bridge: {
    label: "Flush Bridge",
    confirm:
      "This will mark all pending/processing bridge operations as failed. Continue?",
    params: "?medusa=false",
    color: "bg-orange-500 hover:bg-orange-600 text-white border-orange-600",
  },
  medusa: {
    label: "Flush Medusa",
    confirm:
      "This will delete all rows from the Medusa pipeline table (bridge queue untouched). Continue?",
    params: "?bridge=false",
    color: "bg-yellow-500 hover:bg-yellow-600 text-white border-yellow-600",
  },
};

function FlushButton({ target, onDone }: { target: FlushTarget; onDone: () => void }) {
  const [showModal, setShowModal] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const cfg = FLUSH_CONFIG[target];

  const handleFlush = async () => {
    if (input.trim() !== "CONFIRM") return;
    setLoading(true);
    try {
      await fetch(`/admin/quickbooks/pipeline${cfg.params}`, {
        method: "DELETE",
        credentials: "include",
      });
      onDone();
    } catch {
      /* non-blocking */
    } finally {
      setLoading(false);
      setShowModal(false);
      setInput("");
    }
  };

  return (
    <>
      <button
        onClick={() => { setInput(""); setShowModal(true); }}
        className={`px-2 py-1 rounded text-[11px] font-semibold border transition-colors ${cfg.color}`}
      >
        {cfg.label}
      </button>
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-ui-bg-base rounded-lg shadow-xl border border-ui-border-base p-5 w-80">
            <p className="text-sm font-semibold text-ui-fg-base mb-1">{cfg.label}</p>
            <p className="text-xs text-ui-fg-subtle mb-4">{cfg.confirm}</p>
            <p className="text-xs text-ui-fg-muted mb-1">
              Type <span className="font-mono font-bold text-red-600">CONFIRM</span> to proceed:
            </p>
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleFlush(); }}
              className="w-full border border-ui-border-base rounded px-2 py-1 text-xs font-mono mb-3 bg-ui-bg-field text-ui-fg-base focus:outline-none focus:ring-1 focus:ring-red-500"
              placeholder="CONFIRM"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowModal(false); setInput(""); }}
                className="px-3 py-1 rounded text-xs border border-ui-border-base text-ui-fg-base hover:bg-ui-bg-subtle"
              >
                Cancel
              </button>
              <button
                onClick={handleFlush}
                disabled={input.trim() !== "CONFIRM" || loading}
                className="px-3 py-1 rounded text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40"
              >
                {loading ? "Flushing…" : "Flush"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Bridge Stats ─────────────────────────────────────────────────────────────

interface BridgeStats {
  success: boolean;
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  qbBusy: boolean;
  qbBusyUntil: string | null;
  oldestPendingAgeMinutes: number;
  error?: string;
}

export function BridgeStatus() {
  const [stats, setStats] = useState<BridgeStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);

  const fetchStats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/admin/quickbooks/bridge", {
        credentials: "include",
      });
      const data = await res.json();
      setStats(data);
    } catch {
      setStats({
        success: false,
        error: "Bridge unreachable",
        total: 0,
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        qbBusy: false,
        qbBusyUntil: null,
        oldestPendingAgeMinutes: 0,
      });
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const id = setInterval(() => fetchStats(true), 15_000);
    return () => clearInterval(id);
  }, [fetchStats]);

  const postAction = async (action: string) => {
    await fetch("/admin/quickbooks/bridge", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await fetchStats(true);
  };

  const handleResetBusy = async () => {
    setClearing(true);
    try {
      await postAction("reset-busy");
    } catch {
      /* non-blocking */
    } finally {
      setClearing(false);
    }
  };

  const [purging, setPurging] = useState(false);
  const handlePurge = async () => {
    if (
      !confirm(
        "Wipe ALL bridge queue history (completed + failed)? This cannot be undone."
      )
    )
      return;
    setPurging(true);
    try {
      await postAction("purge");
    } catch {
      /* non-blocking */
    } finally {
      setPurging(false);
    }
  };

  const busyUntilLabel = stats?.qbBusyUntil
    ? new Date(stats.qbBusyUntil).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  return (
    <Container>
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <Heading
              level="h3"
              className="text-sm font-medium flex items-center gap-2"
            >
              🔌 QB Bridge Status
              {stats && !stats.error && (
                <span className="text-[10px] font-normal text-green-600">
                  ● Connected
                </span>
              )}
              {stats?.error && (
                <span className="text-[10px] font-normal text-red-500">
                  ● Unreachable
                </span>
              )}
            </Heading>
            <Text className="text-xs text-ui-fg-subtle mt-0.5">
              Live queue state from the QB Web Connector bridge
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <FlushButton target="bridge" onDone={() => fetchStats(true)} />
            <FlushButton target="medusa" onDone={() => fetchStats(true)} />
            <FlushButton target="both" onDone={() => fetchStats(true)} />
            <Button
              variant="secondary"
              size="small"
              onClick={handlePurge}
              isLoading={purging}
            >
              Purge History
            </Button>
            <Button
              variant="secondary"
              size="small"
              onClick={() => fetchStats()}
              isLoading={loading}
            >
              <ArrowPath className="mr-1" /> Refresh
            </Button>
          </div>
        </div>

        {stats?.error ? (
          <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {stats.error}
          </div>
        ) : stats ? (
          <div className="space-y-3">
            {/* qbBusy banner */}
            {stats.qbBusy && (
              <div className="flex items-center justify-between rounded-md bg-orange-50 border border-orange-200 px-4 py-2.5">
                <div>
                  <p className="text-sm font-semibold text-orange-800">
                    ⚠️ QB Busy — queue paused
                  </p>
                  <p className="text-xs text-orange-600 mt-0.5">
                    Web Connector returned "another update in progress".
                    {busyUntilLabel && ` Auto-clears at ${busyUntilLabel}.`}
                    {stats.pending > 0 &&
                      ` ${stats.pending} op${stats.pending !== 1 ? "s" : ""} waiting.`}
                  </p>
                </div>
                <Button
                  size="small"
                  onClick={handleResetBusy}
                  isLoading={clearing}
                  className="ml-4 shrink-0"
                >
                  Clear Busy
                </Button>
              </div>
            )}

            {/* Stats grid */}
            <div className="grid grid-cols-5 gap-2">
              {(
                [
                  {
                    label: "Pending",
                    value: stats.pending,
                    color: stats.pending > 0 ? "orange" : "grey",
                  },
                  {
                    label: "Processing",
                    value: stats.processing,
                    color: stats.processing > 0 ? "blue" : "grey",
                  },
                  {
                    label: "Completed",
                    value: stats.completed,
                    color: "green",
                  },
                  {
                    label: "Failed",
                    value: stats.failed,
                    color: stats.failed > 0 ? "red" : "grey",
                  },
                  { label: "Total", value: stats.total, color: "grey" },
                ] as {
                  label: string;
                  value: number;
                  color: "orange" | "blue" | "green" | "red" | "grey";
                }[]
              ).map(({ label, value, color }) => (
                <div
                  key={label}
                  className="flex flex-col items-center rounded-md border border-ui-border-base p-2 gap-1"
                >
                  <span className="text-[11px] text-ui-fg-muted">{label}</span>
                  <Badge color={color} size="xsmall">
                    {value}
                  </Badge>
                </div>
              ))}
            </div>

            {/* Oldest pending warning */}
            {stats.pending > 0 && stats.oldestPendingAgeMinutes > 10 && (
              <p className="text-xs text-orange-600">
                ⏳ Oldest pending op: {stats.oldestPendingAgeMinutes}m ago — Web
                Connector may not be running.
              </p>
            )}
          </div>
        ) : (
          <div className="text-xs text-ui-fg-muted">Loading…</div>
        )}
      </div>
    </Container>
  );
}
