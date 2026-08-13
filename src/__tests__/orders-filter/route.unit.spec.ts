import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

// ── Mock Meili + the pg connection so the route runs on in-memory fixtures.
const getDocuments = jest.fn();
const index = jest.fn(() => ({ getDocuments }));
jest.mock("meilisearch", () => ({
  MeiliSearch: jest.fn(() => ({ index })),
}));

import { GET } from "../../api/admin/orders/filter/route";

type Json = Record<string, unknown>;

const raw = jest.fn();

function buildReq(query: Json): MedusaRequest {
  return {
    query,
    scope: { resolve: () => ({ raw }) },
  } as unknown as MedusaRequest;
}

function buildRes(): MedusaResponse & { body?: Json; code?: number } {
  const res = {
    json(body: Json) {
      (res as { body?: Json }).body = body;
      return res;
    },
    status(code: number) {
      (res as { code?: number }).code = code;
      return res;
    },
  };
  return res as unknown as MedusaResponse & { body?: Json; code?: number };
}

/** Feeds the route `count` Meili docs, one page at a time. */
function withDocs(count: number): void {
  const docs = Array.from({ length: count }, (_, i) => ({
    id: `order_${i}`,
    payment_status: "",
    effective_payment: "deposited",
    created_at_ts: 1_700_000_000_000 + i,
  }));
  let served = 0;
  getDocuments.mockImplementation(async (opts: { limit: number }) => {
    const page = docs.slice(served, served + opts.limit);
    served += page.length;
    return { results: page, offset: 0, limit: opts.limit, total: docs.length };
  });
  // The hydration join returns nothing; this spec is about the SQL that was
  // built, not about row mapping.
  raw.mockResolvedValue({ rows: [] });
}

/**
 * The projection query, selected by CONTENT rather than by position.
 *
 * It used to be `calls[calls.length - 1]`, which was unambiguous only while the
 * route issued exactly one query. Since separation availability got its own
 * (it computes its verdict in TypeScript through computeSeparationCaps, so its
 * rows have to come back rather than be folded in SQL), "the last call" started
 * naming the wrong one and all five assertions here reported on a query they
 * were never written about. Identity by position is the same trap that shuffled
 * invoice lines when their order was read off ULIDs.
 */
function projectionCall(): { sql: string; bindings: unknown[] } {
  const call = raw.mock.calls.find(([sql]) =>
    typeof sql === "string" && sql.includes("WITH payment_agg AS")
  );
  if (!call) throw new Error("the projection query was never issued");
  const [sql, bindings] = call;
  return { sql: sql as string, bindings: (bindings as unknown[]) ?? [] };
}

/** The separation-availability query, likewise selected by content. */
function availabilityCall(): { sql: string; bindings: unknown[] } {
  const call = raw.mock.calls.find(([sql]) =>
    typeof sql === "string" && sql.includes("claim AS (")
  );
  if (!call) throw new Error("the availability query was never issued");
  const [sql, bindings] = call;
  return { sql: sql as string, bindings: (bindings as unknown[]) ?? [] };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MEILISEARCH_HOST = "http://meili.test";
  process.env.MEILISEARCH_API_KEY = "test-key";
});

describe("GET /admin/orders/filter — conditional CTE scoping", () => {
  // A mismatch between placeholders and bindings is not a wrong number on a
  // screen, it is a 500 for every operator on the tab. knex counts `?`
  // positionally, so the two must move together in BOTH branches.
  it("binds one array per placeholder in the scoped branch", async () => {
    withDocs(50);

    await GET(buildReq({ tab: "open" }), buildRes());

    const { sql, bindings } = projectionCall();
    expect(sql.match(/\?::text\[\]/g)).toHaveLength(bindings.length);
    // 6 = opc + os + order_fulfillment + order_item + invoice_agg (scoped
    // CTEs) + el filtro externo o.id. invoice_agg entró con invoiced_total.
    expect(bindings).toHaveLength(6);
  });

  it("binds one array per placeholder in the unscoped branch", async () => {
    withDocs(1001);

    await GET(buildReq({ tab: "closed" }), buildRes());

    const { sql, bindings } = projectionCall();
    expect(sql.match(/\?::text\[\]/g)).toHaveLength(bindings.length);
    expect(bindings).toHaveLength(1);
  });

  it("restricts every aggregate CTE when the set is small", async () => {
    withDocs(50);

    await GET(buildReq({ tab: "open" }), buildRes());

    const { sql } = projectionCall();
    for (const column of [
      "opc.order_id",
      "os.order_id",
      "order_fulfillment.order_id",
      "order_item.order_id",
      "pos_invoice.order_id",
    ]) {
      expect(sql).toContain(`AND ${column} = ANY(?::text[])`);
    }
  });

  it("leaves the aggregates unrestricted once the set is nearly the whole table", async () => {
    withDocs(1001);

    await GET(buildReq({ tab: "closed" }), buildRes());

    const { sql } = projectionCall();
    expect(sql).not.toContain("AND order_item.order_id = ANY");
    // The outer filter is always present — that is what selects the rows.
    expect(sql).toContain("AND o.id = ANY(?::text[])");
  });

  it("keeps both jsonb_agg calls deterministic", async () => {
    withDocs(10);

    await GET(buildReq({ tab: "open" }), buildRes());

    // Without ORDER BY, element order follows the execution plan, so scoping
    // silently reshuffles these arrays and no hash-based test can be trusted.
    const { sql } = projectionCall();
    expect(sql).toContain("ORDER BY order_fulfillment.id");
    expect(sql).toContain("ORDER BY order_item.id");
  });
});

describe("GET /admin/orders/filter — separation availability query", () => {
  it("binds every placeholder it carries", async () => {
    withDocs(50);

    await GET(buildReq({ tab: "open" }), buildRes());

    const { sql, bindings } = availabilityCall();
    // knex counts EVERY `?` positionally, including one that wanders into a
    // comment — that exact mistake killed PO line deletes in production for six
    // days. The id array and the Miami location are the only two here.
    expect(sql.match(/\?/g)).toHaveLength(bindings.length);
    expect(bindings).toHaveLength(2);
  });

  it("never restricts the cross-order claim to the requested orders", async () => {
    withDocs(50);

    await GET(buildReq({ tab: "open" }), buildRes());

    const { sql } = availabilityCall();
    // The inverse of the rule the projection CTEs follow. This aggregate exists
    // to count what OTHER orders hold, so scoping it would stop subtracting a
    // Closed order's claim and the list would offer units already spoken for.
    const claim = sql.slice(sql.indexOf("claim AS ("), sql.indexOf("SELECT l.order_id"));
    expect(claim).not.toContain("ANY(?::text[])");
    expect(claim).toContain("o2.status NOT IN ('canceled', 'archived')");
  });
});

describe("GET /admin/orders/filter — sales-rep filter", () => {
  it("reaches the index for a rep with no tab or payment filter", async () => {
    withDocs(5);

    await GET(buildReq({ rep: "JTV" }), buildRes());

    // The regression: this used to short-circuit to an empty response, the POS
    // fell back to the most-recent-200 feed, and rep JTV — whose two orders are
    // older than that window — showed as having none.
    expect(getDocuments).toHaveBeenCalled();
    const filter = getDocuments.mock.calls[0][0].filter as string[];
    expect(filter).toContain('(sales_rep_initials = "JTV")');
  });

  it("still short-circuits when nothing needs the index", async () => {
    const res = buildRes();

    await GET(buildReq({}), res);

    expect(getDocuments).not.toHaveBeenCalled();
    expect(res.body).toEqual({ orders: [], estimatedTotalHits: 0 });
  });

  it("combines the rep with a tab instead of replacing it", async () => {
    withDocs(5);

    await GET(buildReq({ tab: "closed", rep: "MFP" }), buildRes());

    const filter = getDocuments.mock.calls[0][0].filter as string[];
    expect(filter).toContain("is_closed = true");
    expect(filter).toContain('(sales_rep_initials = "MFP")');
  });
});
