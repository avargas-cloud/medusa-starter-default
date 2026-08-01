import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../modules/quickbooks-catalog";
import { pushVendorModToQuickBooks } from "../../../../../lib/quickbooks/qb-vendor-mod";
import {
  decideVendorPush,
  QB_RELEVANT_FIELDS,
  syncStampForOutcome,
  termChanged,
  toVendorSnapshot,
} from "../../../../../lib/vendor-terms/push";
import { updateSingleVendorMeiliWorkflow } from "../../../../../workflows/update-single-vendor-meili";

/**
 * Columns a VendorMod needs. Derived from the shared list so a field added
 * there can never be silently missing from the snapshot the Mod sends.
 */
const QB_SNAPSHOT_FIELDS = [...QB_RELEVANT_FIELDS, "full_name"] as const;

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve("query");
  const id = req.params.id;

  const { data } = await query.graph({
    entity: "qb_vendor",
    fields: [
      "id",
      "qb_list_id",
      "full_name",
      "name",
      "company_name",
      "account_number",
      "is_active",
      "first_name",
      "middle_initial",
      "last_name",
      "contact",
      "alt_contact",
      "email",
      "phone",
      "alt_phone",
      "fax",
      "addr1",
      "addr2",
      "city",
      "state",
      "postal_code",
      "country",
      "terms_ref_name",
      "prefill_account_ref_name",
      "vendor_type_ref_name",
      "currency_ref_name",
      "tax_identity",
      "is_vendor_eligible_for_1099",
      "credit_limit",
      "notes",
      "metadata",
      "last_synced_at",
      "sync_status",
      "last_error",
      "qb_operation_id",
      "resolved_at",
      "created_at",
      "updated_at",
    ],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });

  const vendor = data?.[0];
  if (!vendor) {
    return res.status(404).json({ error: "Vendor not found" });
  }

  return res.json({ vendor });
};

type PatchVendorBody = {
  full_name?: string | null;
  name?: string | null;
  company_name?: string | null;
  account_number?: string | null;
  first_name?: string | null;
  middle_initial?: string | null;
  last_name?: string | null;
  contact?: string | null;
  alt_contact?: string | null;
  email?: string | null;
  phone?: string | null;
  alt_phone?: string | null;
  fax?: string | null;
  addr1?: string | null;
  addr2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  terms_ref_name?: string | null;
  prefill_account_ref_name?: string | null;
  vendor_type_ref_name?: string | null;
  currency_ref_name?: string | null;
  tax_identity?: string | null;
  is_vendor_eligible_for_1099?: boolean | null;
  credit_limit?: string | number | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
};

const TEXT_FIELDS = [
  "full_name",
  "name",
  "company_name",
  "account_number",
  "first_name",
  "middle_initial",
  "last_name",
  "contact",
  "alt_contact",
  "email",
  "phone",
  "alt_phone",
  "fax",
  "addr1",
  "addr2",
  "city",
  "state",
  "postal_code",
  "country",
  "terms_ref_name",
  "prefill_account_ref_name",
  "vendor_type_ref_name",
  "currency_ref_name",
  "tax_identity",
  "notes",
] as const;

function normalizeText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export const PATCH = async (
  req: MedusaRequest<PatchVendorBody>,
  res: MedusaResponse
) => {
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const query = req.scope.resolve("query");
  const id = req.params.id;

  const body = req.body ?? {};
  const updates: Record<string, unknown> = {};

  for (const field of TEXT_FIELDS) {
    const normalized = normalizeText(body[field]);
    if (normalized !== undefined) {
      updates[field] = normalized;
    }
  }

  if ("is_vendor_eligible_for_1099" in body) {
    if (
      body.is_vendor_eligible_for_1099 !== null &&
      typeof body.is_vendor_eligible_for_1099 !== "boolean"
    ) {
      return res.status(400).json({
        error: "is_vendor_eligible_for_1099 must be a boolean or null",
      });
    }
    updates.is_vendor_eligible_for_1099 = body.is_vendor_eligible_for_1099;
  }

  if ("credit_limit" in body) {
    if (body.credit_limit === null || body.credit_limit === "") {
      updates.credit_limit = null;
    } else {
      const value = Number(body.credit_limit);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ error: "credit_limit must be a positive number" });
      }
      updates.credit_limit = value;
    }
  }

  const incomingMetadata = body.metadata;
  if (
    incomingMetadata !== undefined &&
    (incomingMetadata === null || typeof incomingMetadata !== "object")
  ) {
    return res.status(400).json({ error: "metadata must be an object" });
  }

  if (Object.keys(updates).length === 0 && incomingMetadata === undefined) {
    return res.status(400).json({ error: "No editable vendor fields provided" });
  }

  // The FULL row, not just id+metadata: a VendorMod carries the complete
  // snapshot (omission is how BillMod silently deleted data in this codebase),
  // and deciding whether to push at all needs the "before" values to compare.
  const { data } = await query.graph({
    entity: "qb_vendor",
    fields: ["id", "metadata", "qb_list_id", ...QB_SNAPSHOT_FIELDS],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });

  const vendor = data?.[0];
  if (!vendor) {
    return res.status(404).json({ error: "Vendor not found" });
  }

  if ("name" in updates && !updates.name) {
    return res.status(400).json({ error: "name cannot be blank" });
  }
  if ("full_name" in updates && !updates.full_name) {
    return res.status(400).json({ error: "full_name cannot be blank" });
  }

  // Setting the vendor's default payment term BY HAND marks it as a manual
  // override: the QuickBooks payment-terms resync then refreshes the term name
  // but leaves the day count alone, so a negotiated term isn't silently undone
  // (see qb-vendor-sync-runner). Send `default_payment_terms_days_manual: false`
  // explicitly to hand the vendor back to QuickBooks.
  const stampManualTerms =
    incomingMetadata !== undefined &&
    "default_payment_terms_days" in incomingMetadata &&
    !("default_payment_terms_days_manual" in incomingMetadata);

  const merged =
    incomingMetadata === undefined
      ? undefined
      : {
          ...(vendor.metadata ?? {}),
          ...incomingMetadata,
          ...(stampManualTerms
            ? {
                default_payment_terms_days_manual: true,
                default_payment_terms_source: "manual",
              }
            : {}),
        };

  await catalog.updateQbVendors({
    id,
    ...updates,
    ...(merged === undefined ? {} : { metadata: merged }),
  });

  void updateSingleVendorMeiliWorkflow(req.scope)
    .run({ input: { vendor_id: id as string } })
    .catch((e) =>
      console.error(`[vendor-patch] Meili sync failed for ${id}:`, e?.message)
    );

  // ── Push to QuickBooks ──────────────────────────────────────────────────────
  // Since 2026-08-01 the POS is where vendors are authored, so an edit that
  // QuickBooks cares about has to reach it. This runs AFTER the local write:
  // the local row is the source of truth and must not be held hostage to a
  // bridge round trip (3-60s). What it must never do is fail quietly — the
  // outcome lands on sync_status/last_error, which the vendor page renders.
  const after = { ...vendor, ...updates };
  const decision = decideVendorPush(
    vendor as Record<string, unknown>,
    after as Record<string, unknown>
  );

  if (decision.push) {
    // Stamp 'waiting' synchronously so the page shows the push is in flight
    // instead of looking synced while the bridge is still chewing on it.
    await catalog.updateQbVendors({ id, sync_status: "waiting" });

    const snapshot = toVendorSnapshot(after as Record<string, unknown>);
    void (async () => {
      try {
        const result = await pushVendorModToQuickBooks(snapshot);
        const stamp = syncStampForOutcome(
          result.ok
            ? { ok: true }
            : {
                ok: false,
                statusCode: result.statusCode,
                statusMessage: result.statusMessage,
              }
        );
        await catalog.updateQbVendors({
          id,
          ...stamp,
          ...(result.ok ? { last_synced_at: new Date() } : {}),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[vendor-patch] VendorMod failed for ${id}:`, message);
        await catalog
          .updateQbVendors({
            id,
            sync_status: "error",
            last_error: `VendorMod did not reach QuickBooks: ${message}`,
          })
          .catch(() => undefined);
      }
    })();
  }

  return res.json({
    success: true,
    metadata: merged ?? vendor.metadata ?? null,
    qb_push: {
      queued: decision.push,
      reason: decision.reason,
      changed: decision.changed,
      term_changed: termChanged(
        vendor as Record<string, unknown>,
        after as Record<string, unknown>
      ),
    },
  });
};
