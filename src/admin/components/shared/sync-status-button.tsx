import { ArrowPath, CheckCircle, ExclamationCircle } from "@medusajs/icons";
import { Button, clx } from "@medusajs/ui";
import { useState, useEffect, useRef } from "react";

type SyncStatus =
  | "idle"
  | "loading"
  | "already_synced"
  | "synced_now"
  | "error";

interface SyncStatusButtonProps {
  entity: "products" | "customers" | "inventory";
  label?: string;
  onSyncComplete?: () => void;
  showForceSync?: boolean; // show secondary Force Sync button (default: false)
}

const RESET_DELAY_MS = 4000;

function useSyncAction(
  entity: SyncStatusButtonProps["entity"],
  onSyncComplete?: () => void
) {
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState<string>("");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleReset = () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setStatus("idle");
      setMessage("");
    }, RESET_DELAY_MS);
  };

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  const run = async (force = false) => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    setStatus("loading");
    setMessage(force ? "Forcing..." : "Checking...");
    try {
      const endpoint =
        entity === "products"
          ? "/admin/search/products/sync"
          : entity === "customers"
            ? "/admin/search/customers/sync"
            : "/admin/search/inventory/sync";

      const url = force ? `${endpoint}?force=true` : endpoint;
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
      });
      const data = await response.json();

      if (data.status === "already_synced") {
        setStatus("already_synced");
        setMessage("Up to Date");
      } else {
        setStatus("synced_now");
        setMessage(
          force
            ? `Force synced (${data.synced ?? "?"})`
            : `Synced (${data.synced ?? "?"})`
        );
        onSyncComplete?.();
      }
    } catch (error) {
      console.error(error);
      setStatus("error");
      setMessage("Sync Failed");
    }
    scheduleReset();
  };

  return { status, message, run };
}

export const SyncStatusButton = ({
  entity,
  label = "Check Sync",
  onSyncComplete,
  showForceSync = false,
}: SyncStatusButtonProps) => {
  const { status, message, run } = useSyncAction(entity, onSyncComplete);

  return (
    <div className="flex items-center gap-1.5">
      {/* ── Primary: Check Sync ───────────────────────────────── */}
      <Button
        variant="secondary"
        size="small"
        onClick={() => run(false)}
        disabled={status === "loading"}
        className={clx(
          "transition-all duration-200 gap-2",
          status === "already_synced" &&
            "bg-transparent text-ui-fg-interactive hover:bg-ui-bg-base-hover border-transparent shadow-none",
          status === "synced_now" &&
            "bg-transparent text-blue-600 hover:bg-ui-bg-base-hover border-transparent shadow-none",
          status === "error" && "bg-red-50 text-red-600"
        )}
      >
        {status === "loading" && <ArrowPath className="animate-spin" />}
        {status === "idle" && <ArrowPath />}
        {status === "already_synced" && (
          <CheckCircle className="text-green-500" />
        )}
        {status === "synced_now" && <CheckCircle className="text-blue-500" />}
        {status === "error" && <ExclamationCircle />}
        <span>{status === "idle" ? label : message}</span>
      </Button>

      {/* ── Secondary: Force Full Sync ────────────────────────── */}
      {showForceSync && (
        <Button
          variant="transparent"
          size="small"
          onClick={() => run(true)}
          disabled={status === "loading"}
          title="Force full re-sync (bypasses smart check)"
          className="text-ui-fg-muted hover:text-ui-fg-base gap-1.5 text-xs"
        >
          <ArrowPath
            className={clx("w-3 h-3", status === "loading" && "animate-spin")}
          />
          Force Sync
        </Button>
      )}
    </div>
  );
};
