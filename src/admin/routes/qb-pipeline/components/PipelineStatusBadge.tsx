import { Badge } from "@medusajs/ui";

import {
  normalizePipelineStatus,
  STATUS_PRESENTATION,
  type PipelineFamily,
} from "../../../../lib/quickbooks/pipeline-status";

/**
 * Shared status badge for every QB Pipeline section (qb-pipeline-status-vocab-20260917).
 *
 * Feed rows can still carry a legacy literal for their family (sales
 * `pending`/`confirmed`, purchase `failed_permanent`/`cancelled`, log
 * `completed`…) until the contract-phase conversion script runs — this badge
 * normalizes whatever it's handed to ONE of the nine canonical meanings before
 * picking a color/label, so every section shows the same badge for the same
 * meaning regardless of which literal is stored underneath.
 */
export function PipelineStatusBadge({
  status,
  family,
  nextRetryAt,
}: {
  status: string | null | undefined;
  family: PipelineFamily;
  nextRetryAt?: string | Date | null;
}) {
  const normalized = normalizePipelineStatus(family, status, nextRetryAt);
  const presentation = STATUS_PRESENTATION[normalized as keyof typeof STATUS_PRESENTATION];

  if (!presentation) {
    // Unknown literal — surface it verbatim instead of silently mapping it to
    // something, same rule normalizePipelineStatus itself follows.
    return (
      <Badge color="grey" size="xsmall">
        {status ?? "—"}
      </Badge>
    );
  }

  const label =
    normalized === "error" && nextRetryAt
      ? `Retrying · next ${formatRetryTime(nextRetryAt)}`
      : presentation.label;

  return (
    <Badge color={presentation.tone} size="xsmall">
      {label}
    </Badge>
  );
}

function formatRetryTime(nextRetryAt: string | Date): string {
  const d =
    nextRetryAt instanceof Date ? nextRetryAt : new Date(nextRetryAt);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  });
}
