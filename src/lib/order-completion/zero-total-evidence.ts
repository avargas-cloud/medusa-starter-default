export const ZERO_TOTAL_EVIDENCE_SCHEMA = 1 as const;
export const ZERO_TOTAL_WARRANTY_REASON = "warranty" as const;

export type ZeroTotalReason = typeof ZERO_TOTAL_WARRANTY_REASON;
export type ZeroTotalEvidenceSource = "legacy_backfill" | "pos_confirmation";

export interface ZeroTotalEvidence {
  schema: typeof ZERO_TOTAL_EVIDENCE_SCHEMA;
  reason: ZeroTotalReason;
  confirmed_at: string;
  confirmed_by: string;
  source: ZeroTotalEvidenceSource;
}

export function buildZeroTotalEvidence(input: {
  confirmedBy: string;
  source: ZeroTotalEvidenceSource;
  confirmedAt?: Date;
}): ZeroTotalEvidence {
  const confirmedBy = input.confirmedBy.trim();
  if (!confirmedBy) {
    throw new Error("confirmedBy is required for zero-total evidence");
  }

  return {
    schema: ZERO_TOTAL_EVIDENCE_SCHEMA,
    reason: ZERO_TOTAL_WARRANTY_REASON,
    confirmed_at: (input.confirmedAt ?? new Date()).toISOString(),
    confirmed_by: confirmedBy,
    source: input.source,
  };
}

export function isValidZeroTotalEvidence(
  value: unknown
): value is ZeroTotalEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<ZeroTotalEvidence>;
  return (
    evidence.schema === ZERO_TOTAL_EVIDENCE_SCHEMA &&
    evidence.reason === ZERO_TOTAL_WARRANTY_REASON &&
    typeof evidence.confirmed_at === "string" &&
    !Number.isNaN(Date.parse(evidence.confirmed_at)) &&
    typeof evidence.confirmed_by === "string" &&
    evidence.confirmed_by.trim().length > 0 &&
    (evidence.source === "pos_confirmation" ||
      evidence.source === "legacy_backfill")
  );
}
