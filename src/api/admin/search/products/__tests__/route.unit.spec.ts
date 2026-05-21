/**
 * Unit tests for POST /admin/search/products
 *
 * Type: mock-based unit test (no DB, no MeiliSearch network calls).
 * The `meilisearch` module is fully mocked; we assert the route forwards the
 * right search options and shapes the response/errors correctly.
 */

// ─── Mock meilisearch BEFORE importing the route (route uses dynamic import) ──

const mockSearch = jest.fn();
const mockIndex = jest.fn().mockReturnValue({ search: mockSearch });

jest.mock("meilisearch", () => ({
  MeiliSearch: jest.fn().mockImplementation(() => ({ index: mockIndex })),
}));

import { POST } from "../route";

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

function buildReq(body: Record<string, unknown>) {
  return { body } as unknown as Parameters<typeof POST>[0];
}

function buildRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json, _status: status, _json: json } as unknown as Parameters<
    typeof POST
  >[1] & { _status: jest.Mock; _json: jest.Mock };
}

const MEILI_RESULT = {
  hits: [{ id: "prod_1", title: "Widget", variant_sku: ["SKU-1"] }],
  estimatedTotalHits: 1,
  processingTimeMs: 3,
  query: "widget",
};

describe("POST /admin/search/products", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIndex.mockReturnValue({ search: mockSearch });
    mockSearch.mockResolvedValue(MEILI_RESULT);
  });

  it("searches the `products` index and returns the raw Meili result", async () => {
    const req = buildReq({
      q: "widget",
      offset: 20,
      limit: 20,
      filter: 'status = "published"',
      sort: ["title:asc"],
    });
    const res = buildRes();
    await POST(req, res);
    await flushPromises();

    expect(mockIndex).toHaveBeenCalledWith("products");
    expect(mockSearch).toHaveBeenCalledWith("widget", {
      offset: 20,
      limit: 20,
      filter: 'status = "published"',
      sort: ["title:asc"],
      attributesToHighlight: ["title", "variant_sku"],
    });
    expect(res.json).toHaveBeenCalledWith(MEILI_RESULT);
  });

  it("applies safe defaults when body fields are missing", async () => {
    const req = buildReq({});
    const res = buildRes();
    await POST(req, res);
    await flushPromises();

    expect(mockSearch).toHaveBeenCalledWith("", {
      offset: 0,
      limit: 20,
      filter: undefined,
      sort: undefined,
      attributesToHighlight: ["title", "variant_sku"],
    });
  });

  it("returns 500 with empty hits when MeiliSearch throws", async () => {
    mockSearch.mockRejectedValue(new Error("meili down"));
    const req = buildReq({ q: "x" });
    const res = buildRes();
    await POST(req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res._json).toHaveBeenCalledWith({ message: "meili down", hits: [] });
  });
});
