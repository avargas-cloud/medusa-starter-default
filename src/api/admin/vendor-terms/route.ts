import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import {
  createTermInQuickBooks,
  QbTermsAddError,
} from "../../../lib/quickbooks/qb-terms-add";
import {
  findTermByName,
  readVendorTermsKnex,
} from "../../../lib/vendor-terms/catalog";
import {
  isValidTerm,
  VENDOR_TERMS_CONTEXT,
  VENDOR_TERMS_FIELD,
  VENDOR_TERMS_SCOPE,
  type VendorTermOption,
} from "../../../lib/vendor-terms/types";

interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * GET /admin/vendor-terms
 *
 * The vendor payment-terms catalog: one entry per term, carrying BOTH the name
 * QuickBooks knows it by and the rule that turns a bill date into a due date.
 *
 * This is the single source for every "Terms" control in the POS — the vendor
 * detail page and the vendor bill both read it, so the name shown on a bill and
 * the days used to compute its due date can no longer disagree.
 *
 * `?qb_only=true` narrows to terms QuickBooks actually has in its Terms list.
 * A `VendorMod` carrying a TermsRef that QB does not know is rejected outright,
 * so any control whose selection gets pushed to QuickBooks asks for that subset
 * rather than filtering client-side and hoping.
 *
 * Rows in `system_defaults` that carry no usable rule are NOT returned as
 * options — a term that resolves to no due date reads as "due today" wherever
 * it lands. They come back under `rejected` so the damage stays visible instead
 * of turning into a silently shorter dropdown.
 */
export const GET = async (
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> => {
  const knex = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as KnexLike;

  try {
    const catalog = await readVendorTermsKnex(knex);

    const qbOnly = String(req.query.qb_only ?? "") === "true";
    const options: VendorTermOption[] = qbOnly
      ? catalog.options.filter((o) => o.exists_in_qb)
      : catalog.options;

    res.json({
      terms: options,
      rejected: catalog.rejected,
      counts: {
        total: catalog.options.length,
        in_quickbooks: catalog.options.filter((o) => o.exists_in_qb).length,
        rejected: catalog.rejected.length,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[vendor-terms] list failed:", message);
    res.status(500).json({ error: message });
  }
};

interface CreateTermBody {
  name?: unknown;
  days?: unknown;
  day_of_month_due?: unknown;
  due_next_month_days?: unknown;
}

const asInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};

/**
 * POST /admin/vendor-terms
 *
 * Creates a payment term — IN QUICKBOOKS FIRST, then locally.
 *
 * That order is the whole point. A `VendorMod` carrying a `TermsRef` that
 * QuickBooks does not know is rejected outright, so a term that exists only
 * here would silently poison every vendor an operator assigns it to: the local
 * save succeeds, the push fails, and the two systems drift on a value nobody
 * thought was risky. Creating it in QB first means the local row can only ever
 * describe something QuickBooks actually has.
 *
 * The reverse failure is harmless and self-healing: if QB accepts and the local
 * insert then fails, re-running creates the local row while QuickBooks answers
 * "already in use" — which this treats as success, because a Terms name is
 * unique in QuickBooks and a duplicate add is REJECTED rather than minting a
 * second term. That uniqueness is what makes this ADD safe to repeat; it does
 * not generalise to other ADDs.
 */
export const POST = async (
  req: MedusaRequest<CreateTermBody>,
  res: MedusaResponse
): Promise<void> => {
  const knex = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as KnexLike;

  const body = req.body ?? {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const days = asInt(body.days);
  const dayOfMonth = asInt(body.day_of_month_due);
  const grace = asInt(body.due_next_month_days);

  if (Number.isNaN(days) || Number.isNaN(dayOfMonth) || Number.isNaN(grace)) {
    res.status(400).json({ error: "days and day_of_month_due must be integers" });
    return;
  }
  if (!isValidTerm({ days, day_of_month_due: dayOfMonth })) {
    res.status(400).json({
      error:
        "a term needs exactly one rule: days (0-365) OR day_of_month_due (1-31), never both and never neither",
    });
    return;
  }

  let qbFailed = false;
  try {
    const existing = await readVendorTermsKnex(knex);
    const clash = findTermByName(existing, name);
    if (clash) {
      // 409 rather than a silent update: renaming or re-ruling a term that
      // vendors already point at is a different, riskier operation and it
      // belongs in the Medusa Admin where the blast radius is visible.
      res.status(409).json({
        error: `A term named "${clash.name}" already exists`,
        term: clash,
      });
      return;
    }

    // Everything from here to the local INSERT is "QuickBooks has to confirm
    // first". A failure inside this window means the term does not exist there.
    qbFailed = true;
    const qbResult = await createTermInQuickBooks(
      days != null
        ? { name, days }
        : {
            name,
            dayOfMonthDue: dayOfMonth as number,
            ...(grace != null ? { dueNextMonthDays: grace } : {}),
          }
    );

    qbFailed = false; // QuickBooks confirmed; anything failing now is ours.

    const metadata = {
      days,
      day_of_month_due: dayOfMonth,
      due_next_month_days: grace,
      exists_in_qb: true,
      qb_synced_at: new Date().toISOString(),
    };

    const inserted = await knex.raw(
      `INSERT INTO system_defaults
         (context, field_name, value, sort_order, data_scope, metadata)
       VALUES (?, ?, ?,
               COALESCE((SELECT MAX(sort_order) + 1 FROM system_defaults
                          WHERE context = ? AND field_name = ?), 1),
               ?, ?::jsonb)
       ON CONFLICT (context, field_name, value) DO UPDATE
         SET metadata = EXCLUDED.metadata, updated_at = NOW()
       RETURNING id, value, sort_order, metadata`,
      [
        VENDOR_TERMS_CONTEXT,
        VENDOR_TERMS_FIELD,
        name,
        VENDOR_TERMS_CONTEXT,
        VENDOR_TERMS_FIELD,
        VENDOR_TERMS_SCOPE,
        JSON.stringify(metadata),
      ]
    );

    res.status(201).json({
      term: inserted.rows[0],
      quickbooks: {
        created: qbResult.created,
        already_existed: qbResult.alreadyExisted,
        operation_id: qbResult.operationId,
      },
    });
  } catch (e) {
    if (e instanceof QbTermsAddError || qbFailed) {
      // Nothing was written locally — deliberately. A term QuickBooks refused,
      // OR could not be reached to confirm, must not become selectable here.
      //
      // Both cases answer to the operator the same way, and that is the point:
      // an unreachable bridge throws a plain Error ("fetch failed"), which as a
      // bare 500 tells them nothing about why their term vanished. What they
      // need to know is identical either way — QuickBooks did not confirm it,
      // so neither did we.
      const message = e instanceof Error ? e.message : String(e);
      console.error("[vendor-terms] QuickBooks did not confirm the term:", message);
      res.status(502).json({
        error: `QuickBooks did not confirm this term, so it was not created here either: ${message}`,
        qb_status_code: e instanceof QbTermsAddError ? e.code : null,
      });
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error("[vendor-terms] create failed:", message);
    res.status(500).json({ error: message });
  }
};
