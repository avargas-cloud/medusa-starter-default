/**
 * Unit tests for POST /admin/search/customers
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

import { POST } from "../../api/admin/search/customers/route";

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
  hits: [{ id: "cus_1", company_name: "Acme", email: "a@acme.com" }],
  estimatedTotalHits: 1,
  processingTimeMs: 2,
  query: "acme",
};

describe("POST /admin/search/customers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIndex.mockReturnValue({ search: mockSearch });
    mockSearch.mockResolvedValue(MEILI_RESULT);
  });

  it("searches the `customers` index and returns the raw Meili result", async () => {
    const req = buildReq({
      q: "acme",
      offset: 0,
      limit: 20,
      filter: 'customer_type = "wholesale"',
      sort: ["company_name:asc"],
    });
    const res = buildRes();
    await POST(req, res);
    await flushPromises();

    expect(mockIndex).toHaveBeenCalledWith("customers");
    expect(mockSearch).toHaveBeenCalledWith("acme", {
      offset: 0,
      limit: 20,
      filter: 'customer_type = "wholesale"',
      sort: ["company_name:asc"],
      attributesToHighlight: ["company_name", "email", "list_id"],
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
      attributesToHighlight: ["company_name", "email", "list_id"],
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
