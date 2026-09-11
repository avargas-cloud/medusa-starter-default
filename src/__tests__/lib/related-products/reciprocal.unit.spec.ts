/**
 * Unit tests for lib/related-products/reciprocal.ts — the pure diff behind
 * PUT /admin/products/:id/related-products.
 *
 * Operator's rule (2026-09-10): the relation is reciprocal ON ADD only.
 * Saving A → [B] appends A to B's list if B has room (MAX 8) and does not
 * already contain A. Removing B from A never touches B — the operator can
 * override each side independently.
 */
import {
  MAX_RELATED,
  planReciprocalWrites,
  sanitizeRelatedIds,
} from "../../../lib/related-products/reciprocal";

describe("sanitizeRelatedIds", () => {
  it("dedupes, drops self and empty, keeps order, caps at MAX_RELATED", () => {
    const ids = ["B", "", "C", "B", "A", "D", "E", "F", "G", "H", "I", "J"];
    expect(sanitizeRelatedIds("A", ids)).toEqual(["B", "C", "D", "E", "F", "G", "H", "I"]);
    expect(MAX_RELATED).toBe(8);
  });
});

describe("planReciprocalWrites", () => {
  it("appends the source to every newly added target that has room", () => {
    const writes = planReciprocalWrites({
      selfId: "A",
      previousIds: ["B"],
      nextIds: ["B", "C", "D"],
      targetLists: { C: [], D: ["Z"] },
    });
    expect(writes).toEqual({
      updates: [
        { id: "C", ids: ["A"] },
        { id: "D", ids: ["Z", "A"] },
      ],
      skippedFull: [],
    });
  });

  it("does not touch targets that already contain the source", () => {
    const writes = planReciprocalWrites({
      selfId: "A",
      previousIds: [],
      nextIds: ["C"],
      targetLists: { C: ["A", "Q"] },
    });
    expect(writes).toEqual({ updates: [], skippedFull: [] });
  });

  it("skips (and reports) targets that are already full", () => {
    const full = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const writes = planReciprocalWrites({
      selfId: "A",
      previousIds: [],
      nextIds: ["C"],
      targetLists: { C: full },
    });
    expect(writes).toEqual({ updates: [], skippedFull: ["C"] });
  });

  it("never cascades removals", () => {
    const writes = planReciprocalWrites({
      selfId: "A",
      previousIds: ["B", "C"],
      nextIds: ["B"],
      targetLists: { C: ["A"] },
    });
    expect(writes).toEqual({ updates: [], skippedFull: [] });
  });

  it("re-adding a previously present id is not an add", () => {
    const writes = planReciprocalWrites({
      selfId: "A",
      previousIds: ["B"],
      nextIds: ["B"],
      targetLists: { B: [] },
    });
    expect(writes).toEqual({ updates: [], skippedFull: [] });
  });
});
