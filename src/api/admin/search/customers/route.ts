import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * Advanced Customer Search — server-side MeiliSearch proxy.
 *
 * Keeps the MeiliSearch read key out of the browser. The `customers` index holds
 * PII (names, emails, phones), so the key must never ship in the admin bundle.
 * Mirrors the inventory/products proxies.
 *
 * POST /admin/search/customers  body: { q, offset, limit, filter, sort }
 * Protected route — admin (`user`) only.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { q, offset, limit, filter, sort } = req.body as {
    q?: string;
    offset?: number;
    limit?: number;
    filter?: string;
    sort?: string[];
  };

  try {
    // Dynamic import to handle ESM module in CommonJS context
    const { MeiliSearch } = await import("meilisearch");

    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    const index = client.index("customers");

    const results = await index.search(q || "", {
      offset: offset || 0,
      limit: limit || 20,
      filter,
      sort,
      attributesToHighlight: ["company_name", "email", "list_id"],
    });

    return res.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    console.error("[Search Proxy Error] customers:", message);
    return res.status(500).json({ message, hits: [] });
  }
};

// Middleware to protect this route (admin only)
export const AUTHENTICATE = ["user"];
