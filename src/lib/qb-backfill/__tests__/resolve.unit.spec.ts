import { loadVendorIndex, loadItemIndex, resolveItemRef, type QueryableDb } from "../resolve";

function fakeDb(rows: Record<string, unknown>[]): QueryableDb {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

describe("qb-backfill/resolve", () => {
  it("loadVendorIndex keyea por qb_list_id", async () => {
    const db = fakeDb([{ id: "qbvnd_1", qb_list_id: "800018B4", full_name: "VEETECH" }]);
    const idx = await loadVendorIndex(db);
    expect(idx.get("800018B4")).toEqual({ id: "qbvnd_1", qb_list_id: "800018B4", full_name: "VEETECH" });
    expect(idx.size).toBe(1);
  });

  it("loadItemIndex indexa por quickbooks_id Y por sku", async () => {
    const db = fakeDb([
      { variant_id: "variant_1", sku: "ESP-SFA50W0840", quickbooks_id: "80001A7D", inventory_item_id: "iitem_1" },
      { variant_id: "variant_2", sku: "SUP-MDA-96-24", quickbooks_id: null, inventory_item_id: "iitem_2" },
    ]);
    const idx = await loadItemIndex(db);
    expect(idx.byQbId.get("80001A7D")?.variant_id).toBe("variant_1");
    expect(idx.bySku.get("SUP-MDA-96-24")?.variant_id).toBe("variant_2");
    expect(idx.byQbId.has("SUP-MDA-96-24")).toBe(false);
  });

  describe("resolveItemRef", () => {
    it("resuelve por ListID primero", () => {
      const idx = {
        byQbId: new Map([["80001A7D", { variant_id: "v1", inventory_item_id: "i1", sku: "SKU1", quickbooks_id: "80001A7D" }]]),
        bySku: new Map(),
      };
      expect(resolveItemRef(idx, { list_id: "80001A7D", full_name: "whatever" })?.variant_id).toBe("v1");
    });
    it("fallback a SKU exacto cuando el ListID no matchea", () => {
      const idx = {
        byQbId: new Map(),
        bySku: new Map([["SKU1", { variant_id: "v1", inventory_item_id: "i1", sku: "SKU1", quickbooks_id: null }]]),
      };
      expect(resolveItemRef(idx, { list_id: "ausente", full_name: "SKU1" })?.variant_id).toBe("v1");
    });
    it("fallback al segmento final tras el último ':' (Grupo:Item)", () => {
      const idx = {
        byQbId: new Map(),
        bySku: new Map([["ItemHijo", { variant_id: "v1", inventory_item_id: "i1", sku: "ItemHijo", quickbooks_id: null }]]),
      };
      expect(resolveItemRef(idx, { list_id: "ausente", full_name: "Grupo:ItemHijo" })?.variant_id).toBe("v1");
    });
    it("null cuando no resuelve por ningún camino", () => {
      const idx = { byQbId: new Map(), bySku: new Map() };
      expect(resolveItemRef(idx, { list_id: "x", full_name: "y" })).toBeNull();
    });
    it("null cuando el ref es null", () => {
      expect(resolveItemRef({ byQbId: new Map(), bySku: new Map() }, null)).toBeNull();
    });
  });
});
