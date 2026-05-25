import { ArrowPath } from "@medusajs/icons";
import { Badge, Heading, IconButton, Text } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";

type Bucket = "pending" | "processing" | "completed" | "failed" | "skipped";

type PipelineSummary = {
  key: string;
  label: string;
  tab: string;
  counts: Record<Bucket, number>;
  total: number;
};

type SummaryResponse = {
  success: boolean;
  pipelines: PipelineSummary[];
  totals: { counts: Record<Bucket, number>; total: number };
  generated_at: string;
  error?: string;
};

const BUCKET_ORDER: Bucket[] = [
  "pending",
  "processing",
  "completed",
  "failed",
  "skipped",
];

const BUCKET_LABEL: Record<Bucket, string> = {
  pending: "Pending",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

// Tailwind text colors per bucket. Kept neutral so the card doesn't scream
// when everything is fine; only red Failed and green Completed pop.
const BUCKET_TEXT: Record<Bucket, string> = {
  pending: "text-ui-fg-subtle",
  processing: "text-ui-tag-blue-text",
  completed: "text-ui-tag-green-text",
  failed: "text-ui-tag-red-text",
  skipped: "text-ui-fg-muted",
};

const REFRESH_MS = 30_000;

export const PipelinesBreakdown = () => {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/admin/quickbooks/pipeline-summary", {
        credentials: "include",
      });
      const json = (await res.json()) as SummaryResponse;
      if (!res.ok || !json.success) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setData(json);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="rounded-lg border border-ui-border-base bg-ui-bg-subtle p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Heading level="h2" className="text-base">
            Pipelines Breakdown
          </Heading>
          <Text className="text-ui-fg-subtle text-sm mt-1">
            Live counts from every Medusa-side QB pipeline. Click a row to
            jump to its tab. Refreshes every 30s.
          </Text>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {data?.generated_at && (
            <Text className="text-ui-fg-muted text-xs">
              Updated {new Date(data.generated_at).toLocaleTimeString()}
            </Text>
          )}
          <IconButton
            size="small"
            variant="transparent"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh pipeline summary"
          >
            <ArrowPath />
          </IconButton>
        </div>
      </div>

      {error ? (
        <div className="mt-3 rounded-md border border-ui-border-error bg-ui-bg-base p-3">
          <Text className="text-ui-fg-error text-sm">
            Failed to load pipeline summary: {error}
          </Text>
        </div>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-ui-fg-subtle text-xs uppercase tracking-wide">
              <th className="text-left font-medium pb-2">Pipeline</th>
              {BUCKET_ORDER.map((b) => (
                <th key={b} className="text-right font-medium pb-2 px-3">
                  {BUCKET_LABEL[b]}
                </th>
              ))}
              <th className="text-right font-medium pb-2 pl-3">Total</th>
            </tr>
          </thead>
          <tbody>
            {(data?.pipelines ?? []).map((p) => (
              <PipelineRow key={p.key} pipeline={p} />
            ))}
            {data?.totals ? (
              <tr className="border-t border-ui-border-base font-semibold">
                <td className="py-2 text-ui-fg-base">All pipelines</td>
                {BUCKET_ORDER.map((b) => (
                  <td
                    key={b}
                    className={`py-2 px-3 text-right tabular-nums ${BUCKET_TEXT[b]}`}
                  >
                    {data.totals.counts[b]}
                  </td>
                ))}
                <td className="py-2 pl-3 text-right tabular-nums text-ui-fg-base">
                  {data.totals.total}
                </td>
              </tr>
            ) : null}
            {!data && !error ? (
              <tr>
                <td colSpan={BUCKET_ORDER.length + 2} className="py-4">
                  <Text className="text-ui-fg-subtle text-sm">Loading…</Text>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
};

type RowProps = { pipeline: PipelineSummary };

const PipelineRow = ({ pipeline }: RowProps) => {
  const onJump = () => {
    // Tabs are rendered as buttons with `value` mapped to the tab key.
    const trigger = document.querySelector<HTMLButtonElement>(
      `[data-state][value="${pipeline.tab}"], [role="tab"][value="${pipeline.tab}"]`
    );
    trigger?.click();
  };

  const failed = pipeline.counts.failed;

  return (
    <tr
      className="border-t border-ui-border-base hover:bg-ui-bg-base-hover cursor-pointer"
      onClick={onJump}
    >
      <td className="py-2 text-ui-fg-base">
        <div className="flex items-center gap-2">
          <span>{pipeline.label}</span>
          {failed > 0 ? (
            <Badge size="2xsmall" color="red">
              {failed} failed
            </Badge>
          ) : null}
        </div>
      </td>
      {BUCKET_ORDER.map((b) => (
        <td
          key={b}
          className={`py-2 px-3 text-right tabular-nums ${BUCKET_TEXT[b]}`}
        >
          {pipeline.counts[b]}
        </td>
      ))}
      <td className="py-2 pl-3 text-right tabular-nums text-ui-fg-base">
        {pipeline.total}
      </td>
    </tr>
  );
};
