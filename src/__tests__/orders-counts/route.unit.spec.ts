import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

// ── Mock the Meili client so the route runs against in-memory fixtures. The
//    route imports "meilisearch" dynamically, so the factory is what it gets.
const getDocuments = jest.fn();
const search = jest.fn();
const index = jest.fn(() => ({ getDocuments, search }));

jest.mock("meilisearch", () => ({
  MeiliSearch: jest.fn(() => ({ index })),
}));

import { GET } from "../../api/admin/orders/counts/route";

type Json = Record<string, unknown>;

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

function buildReq(query: Json = {}): MedusaRequest {
  return { query } as unknown as MedusaRequest;
}

/** Records the filter of every documents-fetch call, in order. */
function captureFilters(totals: number[]): string[][] {
  const seen: string[][] = [];
  let call = 0;
  getDocuments.mockImplementation(async (opts: { filter: string[] }) => {
    seen.push(opts.filter);
    return { results: [], offset: 0, limit: 0, total: totals[call++] ?? 0 };
  });
  return seen;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MEILISEARCH_HOST = "http://meili.test";
  process.env.MEILISEARCH_API_KEY = "test-key";
});

describe("GET /admin/orders/counts", () => {
  it("reads the exact total from the documents endpoint, never estimatedTotalHits", async () => {
    // The regression this guards: index.search() reports
    // estimatedTotalHits, which Meili clamps to pagination.maxTotalHits
    // (default 1000). That is why the All and Closed badges sat frozen at
    // exactly 1000 while the real populations were 1210 and 1193. The
    // documents endpoint's `total` has no such ceiling.
    captureFilters([1210, 16, 1193, 23, 0, 3, 62]);

    const res = buildRes();
    await GET(buildReq(), res);

    expect(search).not.toHaveBeenCalled();
    expect(getDocuments).toHaveBeenCalledTimes(7);
    expect(res.body).toEqual({
      counts: {
        all: 1210,
        open: 16,
        closed: 1193,
        unpaid: 23,
        web: 0,
        separated: 3,
      },
      cancelledCount: 62,
    });
  });

  it("asks for zero documents so a count never transfers rows", async () => {
    getDocuments.mockResolvedValue({
      results: [],
      offset: 0,
      limit: 0,
      total: 5,
    });

    await GET(buildReq(), buildRes());

    for (const call of getDocuments.mock.calls) {
      expect(call[0]).toMatchObject({ limit: 0, fields: ["id"] });
    }
  });

  it("excludes cancelled and voided orders from the tab counts by default", async () => {
    const seen = captureFilters([1, 1, 1, 1, 1, 1, 1]);

    await GET(buildReq(), buildRes());

    // First six calls are the tabs; the seventh is the cancelled chip, which
    // deliberately counts cancelled/voided regardless of the flag.
    for (const filter of seen.slice(0, 6)) {
      expect(filter).toContain("is_canceled = false");
      expect(filter).toContain("is_voided = false");
    }
    expect(seen[6]).toContain("(is_canceled = true OR is_voided = true)");
    expect(seen[6]).not.toContain("is_canceled = false");
  });

  it("counts cancelled orders toward each tab when showCancelled is on", async () => {
    const seen = captureFilters([1, 1, 1, 1, 1, 1, 1]);

    await GET(buildReq({ showCancelled: "true" }), buildRes());

    for (const filter of seen.slice(0, 6)) {
      expect(filter).not.toContain("is_canceled = false");
    }
  });

  it("always excludes estimates", async () => {
    const seen = captureFilters([1, 1, 1, 1, 1, 1, 1]);

    await GET(buildReq(), buildRes());

    for (const filter of seen) {
      expect(filter).toContain("is_draft = false");
    }
  });

  describe("sales-rep filter", () => {
    // The badges label the table beneath them. When the rep filter lived only
    // in the browser, the badge counted every rep while the table showed one —
    // rep MFP read 108 against its true 593, and rep JTV, whose orders predate
    // the loaded window, read as having none at all.
    it("constrains every count, including the cancelled chip", async () => {
      const seen = captureFilters([1, 1, 1, 1, 1, 1, 1]);

      await GET(buildReq({ rep: "MFP" }), buildRes());

      expect(seen).toHaveLength(7);
      for (const filter of seen) {
        expect(filter).toContain('(sales_rep_initials = "MFP")');
      }
    });

    it("matches initials OR name, because the source metadata is inconsistent", async () => {
      const seen = captureFilters([1, 1, 1, 1, 1, 1, 1]);

      await GET(buildReq({ rep: "AG", rep_name: "Ana Gue" }), buildRes());

      expect(seen[0]).toContain(
        '(sales_rep_initials = "AG" OR sales_rep_initials = "Ana Gue")'
      );
    });

    it("adds no rep clause when no rep is selected", async () => {
      const seen = captureFilters([1, 1, 1, 1, 1, 1, 1]);

      await GET(buildReq(), buildRes());

      for (const filter of seen) {
        expect(filter.join(" ")).not.toContain("sales_rep_initials");
      }
    });

    it("ignores a blank rep rather than filtering on an empty string", async () => {
      const seen = captureFilters([1, 1, 1, 1, 1, 1, 1]);

      await GET(buildReq({ rep: "   " }), buildRes());

      for (const filter of seen) {
        expect(filter.join(" ")).not.toContain("sales_rep_initials");
      }
    });

    it("cannot be used to terminate the filter literal", async () => {
      const seen = captureFilters([1, 1, 1, 1, 1, 1, 1]);

      await GET(buildReq({ rep: 'A" OR is_draft = true OR "' }), buildRes());

      const clause = seen[0].find((f) => f.includes("sales_rep_initials")) ?? "";
      expect(clause).not.toContain('"A"');
      expect(clause).toBe(
        '(sales_rep_initials = "A OR is_draft = true OR ")'
      );
    });
  });

  it("honours the effective-date range", async () => {
    const seen = captureFilters([1, 1, 1, 1, 1, 1, 1]);

    await GET(buildReq({ from: "1700000000000", to: "1800000000000" }), buildRes());

    expect(seen[0]).toContain("effective_date_ts >= 1700000000000");
    expect(seen[0]).toContain("effective_date_ts <= 1800000000000");
  });

  it("reports a failure instead of returning zeroes that look like real counts", async () => {
    getDocuments.mockRejectedValue(new Error("meili down"));

    const res = buildRes();
    await GET(buildReq(), res);

    expect(res.code).toBe(500);
    expect(res.body).toMatchObject({ error: "counts_failed" });
    expect(res.body).not.toHaveProperty("counts");
  });
});
