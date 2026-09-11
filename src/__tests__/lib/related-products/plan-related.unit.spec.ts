/**
 * Unit tests for lib/related-products/plan-related.ts — the pure planner
 * behind GET /store/products/:id/related.
 *
 * The rules, in order:
 *   1. The curated list is the source of truth and its ORDER is the operator's.
 *   2. Anything not published is dropped (drafts must never surface).
 *   3. Out-of-stock items keep their relative order but sink to the end.
 *   4. If fewer than `limit` survive, same-category fallback fills the rest,
 *      never repeating a curated id nor the product itself.
 *   5. Only the first `limit` ids are returned.
 */
import { planRelatedProducts } from "../../../lib/related-products/plan-related";

const pub = (id: string, inStock = true) => ({ id, published: true, inStock });
const draft = (id: string) => ({ id, published: false, inStock: true });

describe("planRelatedProducts", () => {
  it("keeps the curated order when everything is valid", () => {
    const out = planRelatedProducts({
      selfId: "A",
      curatedIds: ["B", "C", "D", "E"],
      candidates: [pub("B"), pub("C"), pub("D"), pub("E")],
      fallbackIds: ["X", "Y"],
      limit: 4,
    });
    expect(out).toEqual(["B", "C", "D", "E"]);
  });

  it("drops drafts and unknown ids", () => {
    const out = planRelatedProducts({
      selfId: "A",
      curatedIds: ["B", "C", "GHOST", "D"],
      candidates: [pub("B"), draft("C"), pub("D")],
      fallbackIds: [],
      limit: 4,
    });
    expect(out).toEqual(["B", "D"]);
  });

  it("sinks out-of-stock items to the end, preserving relative order", () => {
    const out = planRelatedProducts({
      selfId: "A",
      curatedIds: ["B", "C", "D", "E", "F"],
      candidates: [pub("B", false), pub("C"), pub("D", false), pub("E"), pub("F")],
      fallbackIds: [],
      limit: 8,
    });
    expect(out).toEqual(["C", "E", "F", "B", "D"]);
  });

  it("fills with fallback when fewer than limit survive, without repeats or self", () => {
    const out = planRelatedProducts({
      selfId: "A",
      curatedIds: ["B", "C"],
      candidates: [pub("B"), draft("C")],
      fallbackIds: ["A", "B", "X", "Y", "Z"],
      limit: 4,
    });
    expect(out).toEqual(["B", "X", "Y", "Z"]);
  });

  it("curated in-stock beats fallback, fallback beats curated out-of-stock? NO — curated always first", () => {
    // The operator chose these; an out-of-stock curated item still outranks
    // an arbitrary same-category product.
    const out = planRelatedProducts({
      selfId: "A",
      curatedIds: ["B", "C"],
      candidates: [pub("B", false), pub("C", false)],
      fallbackIds: ["X", "Y", "Z"],
      limit: 4,
    });
    expect(out).toEqual(["B", "C", "X", "Y"]);
  });

  it("returns only the first `limit` and dedupes curated ids", () => {
    const out = planRelatedProducts({
      selfId: "A",
      curatedIds: ["B", "B", "C", "D", "E", "F"],
      candidates: [pub("B"), pub("C"), pub("D"), pub("E"), pub("F")],
      fallbackIds: [],
      limit: 4,
    });
    expect(out).toEqual(["B", "C", "D", "E"]);
  });

  it("never returns the product itself even if curated", () => {
    const out = planRelatedProducts({
      selfId: "A",
      curatedIds: ["A", "B"],
      candidates: [pub("A"), pub("B")],
      fallbackIds: [],
      limit: 4,
    });
    expect(out).toEqual(["B"]);
  });
});
