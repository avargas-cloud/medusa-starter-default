/**
 * Digest section for the reverse void audit (`qb_reverse_void_finding`).
 *
 * Reads what `qb-reverse-void-monitor` recorded and renders it in the same
 * PipelineSection shape the digest already uses. No window and no dedup
 * stamp, deliberately — a POS-alive document whose QB doc is gone is a fact
 * only a human can resolve, so it repeats every day until someone stamps
 * `resolved_at`. Steady state is zero rows; silence means clean.
 *
 * Fail-isolated: any error here returns null so the digest still goes out —
 * losing the whole digest over this section would hide the pipeline errors
 * the digest exists for. (Filename is underscore-prefixed: the JobLoader
 * excludes by FILENAME, not by the _lib/ directory.)
 */

interface SectionRow {
  id: string;
  medusa_ref: string;
  qb_ref: string;
  step: string;
  error: string;
  retries: number;
  status: string;
  created_at: string | Date;
}

export interface ReverseVoidSection {
  title: string;
  description: string;
  admin_path: string;
  rows: SectionRow[];
}

const ENTITY_LABEL: Record<string, string> = {
  pos_invoice: "invoice",
  pos_credit_memo: "credit memo",
  customer_payment: "payment",
};

const money = (cents: number | string | null): string => {
  const n = Number(cents ?? 0);
  return (n / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
};

export async function collectReverseVoidSection(
  knex: any,
  logger: { warn: (m: string) => void }
): Promise<ReverseVoidSection | null> {
  try {
    const res = await knex.raw(
      `SELECT id, doc_type, reference_id, medusa_ref, qb_txn_id, qb_ref_number,
              kind, qb_time_event, pos_total_cents, first_seen_at
         FROM qb_reverse_void_finding
        WHERE resolved_at IS NULL
        ORDER BY first_seen_at ASC`
    );
    const rows = (res?.rows ?? res ?? []) as Array<Record<string, any>>;
    if (rows.length === 0) return null;

    return {
      title: "Alive in POS, gone in QuickBooks (reverse void audit)",
      description:
        "These POS documents are alive — and may be paid — while their QuickBooks " +
        "document was voided or deleted OUTSIDE the pipeline. This is the direction " +
        "the DB-only reconciler cannot see (how invoice 21281 stayed invisible for a " +
        "day). Verify each one in QuickBooks (/qb-trace), decide re-create vs write-off, " +
        "then stamp resolved_at in qb_reverse_void_finding. Repeats daily until resolved.",
      admin_path: "/qb-pipeline",
      rows: rows.map((r) => ({
        id: String(r.id),
        medusa_ref: r.medusa_ref ?? r.reference_id ?? "",
        qb_ref: r.qb_ref_number ?? r.qb_txn_id ?? "",
        step: `${ENTITY_LABEL[r.doc_type] ?? r.doc_type} ${r.kind} in QB`,
        error:
          `${money(r.pos_total_cents)} still expected on our side; QB doc ` +
          `${r.kind === "deleted" ? "was deleted" : "was voided"}` +
          `${r.qb_time_event ? ` on ${String(r.qb_time_event).slice(0, 10)}` : ""}` +
          ` (txn ${r.qb_txn_id}).`,
        retries: 0,
        status: `${r.kind}_in_qb`,
        // WHEN WE FOUND OUT — the only timestamp an operator can act on here.
        created_at: r.first_seen_at,
      })),
    };
  } catch (err) {
    logger.warn(
      `[qb-reverse-void-section] failed, section omitted from digest: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}
