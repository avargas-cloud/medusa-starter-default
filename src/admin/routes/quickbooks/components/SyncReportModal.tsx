import { useEffect, useRef, useState } from "react";
import { Button, Heading, Text, Badge } from "@medusajs/ui";
import { XMark } from "@medusajs/icons";

interface SyncReportModalProps {
  jobId: string | null;
  title: string;
  onClose: () => void;
}

interface LogLine {
  line: string;
  type: "log" | "warn";
}

/**
 * Read-only modal that streams real-time logs from a QB sync job via SSE.
 * Opens when user clicks "View Report" on any sync section.
 */
export function SyncReportModal({
  jobId,
  title,
  onClose,
}: SyncReportModalProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<
    "connecting" | "running" | "done" | "error" | "no-report"
  >("connecting");
  const bottomRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!jobId) {
      setStatus("no-report");
      return;
    }

    setLines([]);
    setStatus("connecting");

    const src = new EventSource(
      `/admin/quickbooks/sync/stream?job_id=${jobId}`
    );
    sourceRef.current = src;

    src.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "log") {
        const isWarn = msg.line.includes("⚠️") || msg.line.includes("❌");
        setLines((prev) => [
          ...prev,
          { line: msg.line, type: isWarn ? "warn" : "log" },
        ]);
        setStatus("running");
      } else if (msg.type === "done") {
        setStatus(msg.status === "done" ? "done" : "error");
        src.close();
      }
    };

    src.onerror = () => {
      // Job not found or already expired
      setStatus("no-report");
      src.close();
    };

    return () => {
      src.close();
    };
  }, [jobId]);

  // Auto-scroll to bottom as new lines arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const statusBadge = () => {
    if (status === "connecting")
      return <Badge color="blue">Connecting...</Badge>;
    if (status === "running") return <Badge color="blue">Running...</Badge>;
    if (status === "done") return <Badge color="green">Complete ✓</Badge>;
    if (status === "error") return <Badge color="red">Error ✗</Badge>;
    return null;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-ui-bg-base rounded-xl shadow-2xl w-full max-w-3xl mx-4 flex flex-col max-h-[80vh] border border-ui-border-base">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base shrink-0">
          <div className="flex items-center gap-3">
            <Heading level="h2" className="text-ui-fg-base">
              {title}
            </Heading>
            {statusBadge()}
          </div>
          <button
            onClick={onClose}
            className="text-ui-fg-subtle hover:text-ui-fg-base transition-colors p-1 rounded"
          >
            <XMark />
          </button>
        </div>

        {/* Log lines */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-0.5">
          {status === "no-report" && (
            <div className="flex flex-col items-center justify-center h-40 gap-2">
              <Text className="text-ui-fg-subtle text-sm">
                No report available yet.
              </Text>
              <Text className="text-ui-fg-muted text-xs">
                Click "Sync Now" to start a new sync, then open this report.
              </Text>
            </div>
          )}
          {status === "connecting" && lines.length === 0 && (
            <div className="flex items-center justify-center h-40">
              <Text className="text-ui-fg-subtle text-sm animate-pulse">
                Connecting to sync stream...
              </Text>
            </div>
          )}
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2 items-start">
              <Text
                className={`font-mono text-xs leading-relaxed whitespace-pre-wrap break-all
                                    ${l.type === "warn" ? "text-yellow-600 dark:text-yellow-400" : "text-ui-fg-base"}`}
              >
                {l.line}
              </Text>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-ui-border-base shrink-0 flex justify-between items-center">
          <Text className="text-ui-fg-muted text-xs">
            {lines.length} log lines
          </Text>
          <Button
            variant={
              status === "running" || status === "connecting"
                ? "secondary"
                : "primary"
            }
            size="small"
            onClick={onClose}
          >
            {status === "running" || status === "connecting"
              ? "Running (close)"
              : "Close"}
          </Button>
        </div>
      </div>
    </div>
  );
}
