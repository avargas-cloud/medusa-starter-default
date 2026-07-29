/**
 * The `orders` index drift section of the daily digest.
 *
 * Pure: takes an audit result plus what `meilisearch_drift_log` remembers, and
 * returns rows and HTML. No database, no MeiliSearch, no email — so the spec can
 * inject drift instead of manufacturing it.
 *
 * WHY THIS REPEATS EVERY DAY, unlike the QB pipeline sections above it.
 *
 * The digest runs at 00:00. The reconciliation sweep runs every 5 minutes with a
 * 6-minute lookback and heals what it finds. So drift that is still here at
 * midnight is, by construction, drift the automatic machinery did NOT fix — which
 * is exactly the class worth insisting on. There is no `digest_notified_at` and
 * no state table: the steady state is zero rows, so silence already means clean.
 *
 * The QB pipelines needed dedup because a dead row could be re-reported forever
 * with no new information, and there were hundreds of them. Here every row is
 * actionable and is cleared by re-running the sync. Suppressing a repeat would
 * buy quiet at the cost of going silent on unhealed drift, which is the failure
 * this whole safety net exists to prevent.
 *
 * The filename is underscore-prefixed because Medusa's JobLoader excludes by
 * FILENAME, not by directory — a non-job file under src/jobs/ without the prefix
 * crashes the boot with "Config is required for scheduled jobs".
 */
import type { OrderIndexAuditResult } from "../../lib/meilisearch/audit-orders-index";

/**
 * Cap on rows rendered. Whatever is dropped is stated in the email — a silent
 * truncation reads as "that's all of it" when it isn't.
 */
export const MAX_DRIFT_ROWS = 40;

/** What the 5-minute sweep knows about an order, from `meilisearch_drift_log`. */
export interface OrderDriftHistory {
  /** Earliest time the reconciler recorded drift on this order. */
  first_detected: string | Date | null;
  /** Most recent failure message, if the reconciler tried to fix and could not. */
  last_fix_error: string | null;
}

export interface OrderDriftRow {
  order_id: string;
  display_id: number | null;
  /** An audited field name, or a pseudo-field for a whole-document problem. */
  field: string;
  expected: string;
  actual: string;
  /** Plain-language classification of what the reconciler did about it. */
  reconciler: string;
  /** True when the reconciler tried and failed — the most serious class. */
  fixFailed: boolean;
  first_detected: string | Date | null;
}

const show = (v: unknown): string => {
  if (v === null || v === undefined) return "∅";
  if (v === "") return '""';
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fmtDate = (v: string | Date | null): string => {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-US");
};

function classify(history: OrderDriftHistory | undefined): {
  reconciler: string;
  fixFailed: boolean;
} {
  if (!history) {
    // No drift_log row means the 5-minute sweep never looked at this order —
    // its lookback is 6 minutes, so anything older than that is invisible to it
    // unless a trigger re-enqueued the row. That is itself a finding.
    return { reconciler: "never seen by the reconciler", fixFailed: false };
  }
  if (history.last_fix_error) {
    return {
      reconciler: `reconciler FAILED to fix: ${history.last_fix_error.slice(0, 160)}`,
      fixFailed: true,
    };
  }
  return { reconciler: "reconciler fixed it before — it drifted again", fixFailed: false };
}

/**
 * Flattens the audit into email rows: field-level drift first, then whole-document
 * problems (missing / orphaned) as pseudo-fields so one table covers everything.
 *
 * Rows the reconciler tried and failed to fix sort first — an operator reading
 * this at a glance should see the unfixable ones before the merely stale ones.
 */
export function buildOrderDriftRows(
  audit: OrderIndexAuditResult,
  history: ReadonlyMap<string, OrderDriftHistory>
): OrderDriftRow[] {
  const rows: OrderDriftRow[] = [];

  for (const d of audit.drifts) {
    const c = classify(history.get(d.order_id));
    rows.push({
      order_id: d.order_id,
      display_id: d.display_id,
      field: d.field,
      expected: show(d.expected),
      actual: show(d.actual),
      reconciler: c.reconciler,
      fixFailed: c.fixFailed,
      first_detected: history.get(d.order_id)?.first_detected ?? null,
    });
  }

  for (const m of audit.missing) {
    const c = classify(history.get(m.order_id));
    rows.push({
      order_id: m.order_id,
      display_id: m.display_id,
      field: "(no document in the index)",
      expected: "a document",
      actual: "∅",
      reconciler: c.reconciler,
      fixFailed: c.fixFailed,
      first_detected: history.get(m.order_id)?.first_detected ?? null,
    });
  }

  for (const id of audit.orphans) {
    const c = classify(history.get(id));
    rows.push({
      order_id: id,
      display_id: null,
      field: "(orphaned — no such order)",
      expected: "∅",
      actual: "a document",
      reconciler: c.reconciler,
      fixFailed: c.fixFailed,
      first_detected: history.get(id)?.first_detected ?? null,
    });
  }

  rows.sort(
    (a, b) =>
      Number(b.fixFailed) - Number(a.fixFailed) ||
      (a.display_id ?? Number.MAX_SAFE_INTEGER) -
        (b.display_id ?? Number.MAX_SAFE_INTEGER) ||
      a.field.localeCompare(b.field)
  );

  return rows;
}

/**
 * Renders the section. Returns "" when there is nothing wrong, so a clean index
 * contributes no HTML at all and a digest with no QB errors either sends nothing.
 */
export function renderOrderDriftSection(
  rows: readonly OrderDriftRow[],
  audit: Pick<
    OrderIndexAuditResult,
    "ordersInDb" | "docsInIndex" | "driftedDocs" | "missing" | "orphans"
  >,
  adminBaseUrl: string
): string {
  if (rows.length === 0) return "";

  const shown = rows.slice(0, MAX_DRIFT_ROWS);
  const dropped = rows.length - shown.length;
  const unfixable = rows.filter((r) => r.fixFailed).length;

  const heading = `
    <tr>
      <td style="padding: 16px 0 8px 0;">
        <h2 style="margin: 0; font-size: 18px; color: #111;">
          Orders Search Index
          <span style="font-size: 14px; color: #888; font-weight: normal;">
            (${audit.driftedDocs} order${audit.driftedDocs === 1 ? "" : "s"} with wrong fields,
             ${audit.missing.length} missing, ${audit.orphans.length} orphaned)
          </span>
        </h2>
        <p style="margin: 4px 0 0; font-size: 13px; color: #555;">
          The <code>orders</code> index disagrees with the database. Rebuilt through the same
          path the sync uses, so this is index-vs-database, not a difference in how it was read.
          Checked ${audit.ordersInDb} orders against ${audit.docsInIndex} documents.
          ${
            unfixable > 0
              ? `<strong style="color: #b91c1c;">${unfixable} row${unfixable === 1 ? "" : "s"} the reconciler tried and failed to fix.</strong>`
              : ""
          }
        </p>
        <p style="margin: 4px 0 0; font-size: 13px; color: #555;">
          Fix: re-run <code>sync-meili-orders</code>, then find out why it drifted.
          This repeats daily until the index agrees — the 5-minute sweep already had its chance.
        </p>
        <p style="margin: 4px 0 0; font-size: 13px;">
          <a href="${adminBaseUrl}/orders" style="color: #2563eb;">Open Orders in Admin →</a>
        </p>
      </td>
    </tr>`;

  const tableRows = shown
    .map(
      (r) => `
      <tr>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-family: monospace; font-size: 12px; color: #111;">
          ${escapeHtml(r.display_id != null ? `#${r.display_id}` : r.order_id)}
        </td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-family: monospace; font-size: 12px; color: #111;">
          ${escapeHtml(r.field)}
        </td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 12px; color: #166534;">
          ${escapeHtml(r.expected.slice(0, 80))}
        </td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 12px; color: #b91c1c;">
          ${escapeHtml(r.actual.slice(0, 80))}
        </td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 11px; color: ${r.fixFailed ? "#b91c1c" : "#555"};">
          ${escapeHtml(r.reconciler)}
        </td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 12px; color: #666;">
          ${fmtDate(r.first_detected)}
        </td>
      </tr>`
    )
    .join("");

  const droppedNote =
    dropped > 0
      ? `<tr><td style="padding: 8px 0 0 0; font-size: 12px; color: #555;">
           … and ${dropped} more row${dropped === 1 ? "" : "s"} not shown (capped at ${MAX_DRIFT_ROWS}).
           Run <code>verify-meili-orders-integrity</code> for the full list.
         </td></tr>`
      : "";

  return (
    heading +
    `<tr><td style="padding: 0 0 16px 0;">
      <table cellpadding="0" cellspacing="0" style="width: 100%; border: 1px solid #e5e7eb; border-collapse: collapse; font-family: -apple-system, system-ui, sans-serif;">
        <thead>
          <tr style="background: #f9fafb;">
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">Order</th>
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">Field</th>
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">Database says</th>
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">Index says</th>
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">Reconciler</th>
            <th style="padding: 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280;">First Detected</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </td></tr>` +
    droppedNote
  );
}
