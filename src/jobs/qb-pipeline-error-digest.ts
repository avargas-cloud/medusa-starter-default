import { MedusaContainer } from "@medusajs/framework/types";

import { sendMail } from "../utils/mailer";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
const DIGEST_RECIPIENT =
  process.env.QB_PIPELINE_DIGEST_TO || "a.vargas@ecopowertech.com";
const ADMIN_BASE_URL =
  process.env.MEDUSA_ADMIN_URL || "http://localhost:9000/app";
/**
 * Time window for the digest, in hours. Captures any pipeline row whose
 * status was last updated within this window — i.e. errors that broke today
 * AND retries that failed today. Older still-broken rows already showed up
 * in earlier digests, so we don't repeat them. Override per-env if needed.
 */
const DIGEST_WINDOW_HOURS = Number(
  process.env.QB_PIPELINE_DIGEST_WINDOW_HOURS || 24
);

/**
 * Daily digest of QuickBooks pipeline errors across all 4 pipelines.
 * Runs daily at midnight (00:00 server time).
 * Skips email send when zero errors across all pipelines (no spam).
 */

type PipelineErrorRow = {
  id: string;
  /** Human-friendly Medusa-side document number (PAY-2051, E1346, INV-1234, SKU, PO-007). */
  medusa_ref: string;
  /** QuickBooks-side reference (qb_ref_number, qb_txn_number, ListID). */
  qb_ref: string;
  /** Sub-type / pipeline step for context (apply_payment, void_invoice, mod, etc.). */
  step: string;
  error: string | null;
  retries: number;
  status: string;
  created_at: string | Date | null;
};

type PipelineSection = {
  title: string;
  description: string;
  rows: PipelineErrorRow[];
  admin_path: string;
};

const fmt = (v: string | Date | null): string => {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-US");
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const renderSection = (section: PipelineSection): string => {
  const heading = `
    <tr>
      <td style="padding: 16px 0 8px 0;">
        <h2 style="margin: 0; font-size: 18px; color: #111;">
          ${escapeHtml(section.title)}
          <span style="font-size: 14px; color: #888; font-weight: normal;">
            (${section.rows.length} error${section.rows.length === 1 ? "" : "s"})
          </span>
        </h2>
        <p style="margin: 4px 0 0; font-size: 13px; color: #555;">
          ${escapeHtml(section.description)}
        </p>
        <p style="margin: 4px 0 0; font-size: 13px;">
          <a href="${ADMIN_BASE_URL}${section.admin_path}"
             style="color: #2563eb;">Open in Admin →</a>
        </p>
      </td>
    </tr>`;

  if (section.rows.length === 0) {
    return (
      heading +
      `<tr><td style="padding: 8px 0 16px 0; color: #16a34a; font-size: 13px;">
        ✓ No errors in this pipeline.
      </td></tr>`
    );
  }

  const tableRows = section.rows
    .map(
      (r) => `
      <tr>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-family: monospace; font-size: 12px; color: #111;">
          ${escapeHtml(r.medusa_ref || "—")}
        </td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-family: monospace; font-size: 12px; color: #111;">
          ${escapeHtml(r.qb_ref || "—")}
        </td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 11px; color: #555;">
          ${escapeHtml(r.step || "—")}
        </td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 12px;">
          <span style="background: ${r.status === "failed_permanent" || r.status === "failed" ? "#fee2e2" : "#fef3c7"}; padding: 2px 6px; border-radius: 4px;">
            ${escapeHtml(r.status)}
          </span>
        </td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 12px; text-align: center;">
          ${r.retries}
        </td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 12px; color: #666;">
          ${fmt(r.created_at)}
        </td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 12px; color: #b91c1c; max-width: 320px;">
          ${escapeHtml((r.error ?? "").slice(0, 240))}${(r.error ?? "").length > 240 ? "…" : ""}
        </td>
      </tr>`
    )
    .join("");

  return (
    heading +
    `<tr><td style="padding: 0 0 16px 0;">
      <table cellpadding="0" cellspacing="0" style="width: 100%; border: 1px solid #e5e7eb; border-collapse: collapse; font-family: -apple-system, system-ui, sans-serif;">
        <thead>
          <tr style="background: #f9fafb;">
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">Medusa #</th>
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">QB Ref</th>
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">Step</th>
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">Status</th>
            <th style="padding: 8px; text-align: center; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">Retries</th>
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">First Seen</th>
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">Error</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </td></tr>`
  );
};

export default async function qbPipelineErrorDigest(
  container: MedusaContainer
) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger");
  const knex = (container as any).resolve("__pg_connection__");

  const windowSinceIso = new Date(
    Date.now() - DIGEST_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString();

  // ── 1. Sales pipeline (qb_order_pipeline) — raw SQL with display_id join
  // status='failed' alone isn't a reliable "needs a human" signal here — the
  // dispatcher auto-retries any failed row with next_retry_at set (backoff
  // ladder up to MAX_RETRIES, see row-mutations.ts), often resolving within
  // minutes. Excluding those avoids reporting transient failures our own
  // retry loop already fixed by the time this digest is read.
  const salesRes = await knex.raw(
    `SELECT
       p.id,
       p.order_id,
       p.step,
       p.status,
       p.error,
       p.retry_count,
       p.created_at,
       p.updated_at,
       p.medusa_ref_number,
       p.qb_ref_number,
       p.qb_txn_id,
       o.display_id AS order_display_id
     FROM qb_order_pipeline p
     LEFT JOIN "order" o ON o.id = p.order_id
     WHERE p.status = 'failed'
       AND p.next_retry_at IS NULL
       AND (
         -- (a) broke or retried inside the window — the daily "what happened
         -- today" bucket.
         p.updated_at >= ?
         -- (b) DORMANT: exhausted its retry ladder and nothing touches it any
         -- more, so updated_at froze and (a) stopped matching the day after.
         -- Without this a dead row is reported exactly once and then goes
         -- silent forever while still being broken (CM-1087: 14 days). Same
         -- dedup as the item pipeline — re-surface when it's new, when
         -- something moved since we last said so, or after a week of silence.
         OR (p.digest_notified_at IS NULL
             OR p.updated_at > p.digest_notified_at
             OR p.digest_notified_at < now() - interval '7 days')
       )
     ORDER BY p.updated_at DESC
     LIMIT 500`,
    [windowSinceIso]
  );
  const salesErrors = (salesRes?.rows ?? salesRes ?? []) as Array<{
    id: string;
    order_id: string | null;
    step: string | null;
    status: string;
    error: string | null;
    retry_count: number;
    created_at: string;
    medusa_ref_number: string | null;
    qb_ref_number: string | null;
    qb_txn_id: string | null;
    order_display_id: number | null;
  }>;

  // ── 2. Item pipeline (qb_item_pipeline) — raw SQL so we can filter by updated_at.
  // Includes (a) recent error/failed rows AND (b) STUCK rows: anything non-terminal
  // older than 2h. (b) is the seq-120 blind spot — an actively-looping row keeps
  // updated_at fresh, so an updated_at-only filter never surfaces it; created_at +
  // submit_count do. submit_count > 1 with status=waiting is the loop fingerprint.
  const itemRes = await knex.raw(
    `SELECT
       id,
       sku,
       op_action,
       status,
       qb_list_id,
       qb_id,
       last_error,
       retries,
       submit_count,
       recovery_mode,
       created_at,
       updated_at
     FROM qb_item_pipeline
     WHERE deleted_at IS NULL
       AND (
         -- 'error' rows with a scheduled next_retry_at will self-heal on their
         -- own (same auto-retry ladder as the other 3 pipelines) — only
         -- failed_permanent (exhausted) or an 'error' with nothing scheduled
         -- counts as a real, non-self-resolving error.
         ((status = 'failed_permanent' OR (status = 'error' AND next_retry_at IS NULL))
          AND updated_at >= ?)
         OR (status NOT IN ('synced', 'failed_permanent')
             AND created_at < now() - interval '2 hours'
             -- Dedup: don't repeat the exact same still-broken incident every
             -- day. Re-surface only if it's new (never notified), something
             -- happened since we last told the user (a retry attempt bumped
             -- updated_at), or a week of total silence has passed (safety net
             -- so a truly-frozen row doesn't fall off the radar forever).
             AND (digest_notified_at IS NULL
                  OR updated_at > digest_notified_at
                  OR digest_notified_at < now() - interval '7 days'))
       )
     ORDER BY updated_at DESC
     LIMIT 500`,
    [windowSinceIso]
  );
  const itemErrors = (itemRes?.rows ?? itemRes ?? []) as Array<{
    id: string;
    sku: string | null;
    op_action: string | null;
    status: string;
    qb_list_id: string | null;
    qb_id: string | null;
    last_error: string | null;
    retries: number;
    submit_count: number | null;
    recovery_mode: string | null;
    created_at: string;
    updated_at: string;
  }>;

  // ── 3. Inventory adjustment pipeline — join inventory_count for # ───────
  const invRes = await knex.raw(
    `SELECT
       p.id,
       p.inventory_count_id,
       p.status,
       p.last_error,
       p.retries,
       p.created_at,
       p.updated_at,
       p.qb_txn_number,
       ic.number AS count_number
     FROM qb_inventory_adjustment_pipeline p
     LEFT JOIN inventory_count ic ON ic.id = p.inventory_count_id
     WHERE p.status = 'error'
       AND p.next_retry_at IS NULL
       AND p.updated_at >= ?
       AND p.deleted_at IS NULL
     ORDER BY p.updated_at DESC
     LIMIT 500`,
    [windowSinceIso]
  );
  const invErrors = (invRes?.rows ?? invRes ?? []) as Array<{
    id: string;
    inventory_count_id: string | null;
    status: string;
    last_error: string | null;
    retries: number;
    created_at: string;
    qb_txn_number: string | null;
    count_number: string | null;
  }>;

  // ── 4. Purchase order pipeline — join purchase_order for # ──────────────
  const poRes = await knex.raw(
    `SELECT
       p.id,
       p.purchase_order_id,
       p.status,
       p.last_error,
       p.retries,
       p.created_at,
       p.updated_at,
       p.qb_txn_number,
       po.number AS po_number,
       po.reference_number AS po_reference_number
     FROM qb_purchase_order_pipeline p
     LEFT JOIN purchase_order po ON po.id = p.purchase_order_id
     WHERE (p.status = 'failed_permanent' OR (p.status = 'error' AND p.next_retry_at IS NULL))
       AND p.updated_at >= ?
       AND p.deleted_at IS NULL
     ORDER BY p.updated_at DESC
     LIMIT 500`,
    [windowSinceIso]
  );
  const poErrors = (poRes?.rows ?? poRes ?? []) as Array<{
    id: string;
    purchase_order_id: string | null;
    status: string;
    last_error: string | null;
    retries: number;
    created_at: string;
    qb_txn_number: string | null;
    po_number: string | null;
    po_reference_number: string | null;
  }>;

  const sections: PipelineSection[] = [
    {
      title: "Sales Pipeline",
      description:
        "Failed QB sync of orders, invoices, payments, refunds — excludes rows still on an automatic retry schedule.",
      admin_path: "/qb-pipeline",
      rows: salesErrors.map((r) => ({
        id: r.id,
        // Prefer document number (PAY-2051, E1346, INV-1234). Fall back to
        // order display_id (#1234), then to the internal text id as last resort.
        medusa_ref:
          r.medusa_ref_number ||
          (r.order_display_id != null ? `#${r.order_display_id}` : "") ||
          r.order_id ||
          "",
        qb_ref: r.qb_ref_number ?? r.qb_txn_id ?? "",
        step: r.step ?? "",
        error: r.error,
        retries: r.retry_count ?? 0,
        status: r.status,
        created_at: r.created_at,
      })),
    },
    {
      title: "Item Pipeline",
      description:
        "Failed + STUCK QB sync of product items (create + edit) — excludes rows still on an automatic retry schedule. Exhausted rows are failed_permanent; non-terminal rows older than 2h (incl. resubmit loops, shown as submit×N) are surfaced even if recently updated, and MAY repeat across daily digests until they reach synced/failed_permanent.",
      admin_path: "/qb-pipeline",
      rows: itemErrors.map((r) => ({
        id: r.id,
        medusa_ref: r.sku ?? "",
        qb_ref: r.qb_list_id ?? r.qb_id ?? "",
        // Fold loop fingerprint into the step cell: action · submitN× · recovery.
        step: [
          r.op_action ?? "",
          (r.submit_count ?? 0) > 1 ? `submit${r.submit_count}×` : "",
          r.recovery_mode && r.recovery_mode !== "none" ? r.recovery_mode : "",
        ]
          .filter(Boolean)
          .join(" · "),
        error:
          r.last_error ??
          (r.status !== "error" && r.status !== "failed_permanent"
            ? `Stuck in '${r.status}' since ${new Date(r.created_at).toLocaleString("en-US")}`
            : null),
        retries: r.retries ?? 0,
        status: r.status,
        created_at: r.created_at,
      })),
    },
    {
      title: "Inventory Adjustment Pipeline",
      description:
        "Failed QB inventory adjustments from POS counts — excludes rows still on an automatic retry schedule.",
      admin_path: "/qb-pipeline",
      rows: invErrors.map((r) => ({
        id: r.id,
        medusa_ref: r.count_number ?? r.inventory_count_id ?? "",
        qb_ref: r.qb_txn_number ?? "",
        step: "inv_adjustment",
        error: r.last_error,
        retries: r.retries ?? 0,
        status: r.status,
        created_at: r.created_at,
      })),
    },
    {
      title: "Purchase Pipeline",
      description:
        "Failed QB sync of purchase orders + item receipts — excludes rows still on an automatic retry schedule.",
      admin_path: "/qb-pipeline",
      rows: poErrors.map((r) => ({
        id: r.id,
        medusa_ref:
          r.po_reference_number ?? r.po_number ?? r.purchase_order_id ?? "",
        qb_ref: r.qb_txn_number ?? "",
        step: "purchase_order",
        error: r.last_error,
        retries: r.retries ?? 0,
        status: r.status,
        created_at: r.created_at,
      })),
    },
  ];

  const totalErrors = sections.reduce((acc, s) => acc + s.rows.length, 0);

  if (totalErrors === 0) {
    logger.info(
      `[qb-pipeline-error-digest] no errors across 4 pipelines — skipping email`
    );
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const windowLabel =
    DIGEST_WINDOW_HOURS === 24
      ? "last 24 hours"
      : `last ${DIGEST_WINDOW_HOURS} hours`;
  const subject = `[QB Pipeline] ${totalErrors} new error${totalErrors === 1 ? "" : "s"} (${windowLabel}) — ${today}`;

  const html = `
<!DOCTYPE html>
<html><body style="margin: 0; padding: 0; background: #f5f5f5; font-family: -apple-system, system-ui, sans-serif;">
  <table cellpadding="0" cellspacing="0" style="width: 100%; max-width: 720px; margin: 0 auto; padding: 24px;">
    <tr>
      <td>
        <h1 style="margin: 0; font-size: 22px; color: #111;">QuickBooks Pipeline Errors</h1>
        <p style="margin: 6px 0 0; font-size: 14px; color: #555;">
          Daily digest for ${today} — ${totalErrors} error${totalErrors === 1 ? "" : "s"} from the ${windowLabel} across 4 pipelines.
          <br/>
          <span style="color: #888; font-size: 12px;">
            Rows still on an automatic retry schedule are excluded — only genuinely stuck errors are shown.
            Older still-broken rows are not repeated here EXCEPT in the Item Pipeline's STUCK bucket
            (resubmit loops), which re-surfaces daily until it reaches synced/failed_permanent.
            Window: ${windowSinceIso} → now.
          </span>
        </p>
      </td>
    </tr>
    ${sections.map(renderSection).join("")}
    <tr>
      <td style="padding: 24px 0; border-top: 1px solid #e5e7eb; color: #888; font-size: 11px;">
        Auto-generated by qb-pipeline-error-digest cron. Recipients: ${escapeHtml(DIGEST_RECIPIENT)}.
      </td>
    </tr>
  </table>
</body></html>`;

  try {
    const sent = await sendMail({
      to: DIGEST_RECIPIENT,
      subject,
      html,
    });
    if (sent) {
      logger.info(
        `[qb-pipeline-error-digest] sent: ${totalErrors} errors → ${DIGEST_RECIPIENT}`
      );
      // Stamp every reported item-pipeline row so the STUCK bucket's dedup
      // window (above) can tell "already told them" from "new development".
      // Only do this on a confirmed send — if sendMail fails, leave rows
      // un-stamped so they're retried in tomorrow's digest.
      const stuckIds = itemErrors.map((r) => r.id);
      if (stuckIds.length > 0) {
        await knex.raw(
          `UPDATE qb_item_pipeline SET digest_notified_at = now() WHERE id = ANY(?)`,
          [stuckIds]
        );
      }
      // Same for the sales pipeline's dormant-failure bucket — without the
      // stamp its dedup can't distinguish "already told them" from "new", and
      // every dead row would be re-reported every single day.
      const salesIds = salesErrors.map((r) => r.id);
      if (salesIds.length > 0) {
        await knex.raw(
          `UPDATE qb_order_pipeline SET digest_notified_at = now() WHERE id = ANY(?)`,
          [salesIds]
        );
      }
    } else {
      logger.warn(
        `[qb-pipeline-error-digest] mail not sent — RESEND_API_KEY missing`
      );
    }
  } catch (e: any) {
    logger.error(`[qb-pipeline-error-digest] sendMail failed: ${e.message}`);
  }
}

/**
 * Daily at 00:00 server time (midnight).
 * The 1-hour DST shift twice a year is acceptable for a daily ops digest.
 */
export const config = {
  name: "qb-pipeline-error-digest",
  schedule: "0 0 * * *",
};
