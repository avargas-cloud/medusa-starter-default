import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import { INVOICE_MODULE } from "../../../../modules/invoices";
import { sortDocItemsByInsertion } from "../_lib/item-order";

/**
 * GET /admin/invoices/search?q=<term>
 *
 * Server-side full-text search over the entire pos_invoices DB via
 * MeiliSearch. Used by the POS /invoices search bar — covers fields
 * the SQL list endpoint cannot:
 *   • invoice_number              ("20057")
 *   • order_document_number       ("S10090") — finds the invoice via its order
 *   • customer name / email / phone (digit-normalized) / company
 *   • QB invoice ref number
 *   • notes / payment_method
 *
 * Returns the same `{ invoices: [...] }` shape (with `customer` enrichment)
 * as `/admin/invoices` so the frontend can swap data sources transparently.
 */

const POS_INVOICES_INDEX = "pos_invoices";

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const q = (req.query.q as string | undefined)?.trim() ?? "";
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

  if (!q) {
    return res.json({
      invoices: [],
      query: "",
      processingTimeMs: 0,
      estimatedTotalHits: 0,
    });
  }

  try {
    const { MeiliSearch } = await import("meilisearch");
    const meili = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    // If the user typed something phone-shaped (≥7 digits when stripped),
    // normalize to digits-only and search the dedicated phone_digits field.
    const digits = q.replace(/\D/g, "");
    const searchTerm =
      digits.length >= 7 && digits.length !== q.length ? digits : q;

    const meiliRes = await meili.index(POS_INVOICES_INDEX).search(searchTerm, {
      limit,
      attributesToRetrieve: ["id"],
      sort: ["created_at_ts:desc"],
    });

    const ids: string[] = meiliRes.hits
      .map((h: any) => h?.id)
      .filter((id: unknown): id is string => typeof id === "string" && !!id);

    if (ids.length === 0) {
      return res.json({
        invoices: [],
        query: meiliRes.query,
        processingTimeMs: meiliRes.processingTimeMs,
        estimatedTotalHits: meiliRes.estimatedTotalHits,
      });
    }

    // Hydrate from Medusa with the same enrichment shape /admin/invoices uses
    const invoiceService = (req.scope as any).resolve(INVOICE_MODULE);
    const customerModule = (req.scope as any).resolve(Modules.CUSTOMER);

    const invoices = await invoiceService.listPosInvoices(
      { id: ids },
      {
        relations: ["items", "tracking_links"],
      }
    );

    const customerIds = [
      ...new Set(
        (invoices || [])
          .map((i: any) => i.customer_id)
          .filter((c: unknown): c is string => typeof c === "string" && !!c)
      ),
    ];
    const customers = customerIds.length
      ? await customerModule.listCustomers(
          { id: customerIds },
          {
            select: [
              "id",
              "first_name",
              "last_name",
              "email",
              "phone",
              "company_name",
            ],
          }
        )
      : [];
    const customerMap = Object.fromEntries(
      customers.map((c: any) => [c.id, c])
    );

    const enriched = (invoices || []).map((inv: any) => ({
      ...inv,
      // The `items` hasMany has no default ORDER BY → restore insertion (ULID id)
      // order so comment/header lines stay where the operator placed them.
      items: sortDocItemsByInsertion(inv.items),
      customer: customerMap[inv.customer_id] ?? null,
    }));

    // Preserve Meili's relevance order
    const byId = new Map<string, any>();
    for (const inv of enriched) byId.set(inv.id, inv);
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

    return res.json({
      invoices: ordered,
      query: meiliRes.query,
      processingTimeMs: meiliRes.processingTimeMs,
      estimatedTotalHits: meiliRes.estimatedTotalHits,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: "search_failed",
      message: err?.message || "Unknown error",
      invoices: [],
    });
  }
};

export const AUTHENTICATE = ["user"];
