import { buildQbStepInput } from "../../workflows/pos/update-pos-product";
import type { UpdatePosProductInput } from "../../workflows/pos/update-pos-product";

const base: UpdatePosProductInput = {
  id: "prod_1",
  variant_id: "var_1",
  sku: "ESP-NFA30W0460",
};

describe("buildQbStepInput — SalesPrice handling", () => {
  describe("mod (qb_id present)", () => {
    const modBase: UpdatePosProductInput = {
      ...base,
      qb_id: "80001BE4-1762203774",
      qb_edit_sequence: "1780010536",
    };

    it("sends SalesPrice when the edit carries a retail_price", () => {
      const out = buildQbStepInput({ ...modBase, retail_price: 42 });
      expect(out.action).toBe("mod");
      expect(out.data.SalesPrice).toBe(42);
    });

    it("sends an explicit 0 (a real $0 price is legitimate)", () => {
      const out = buildQbStepInput({ ...modBase, retail_price: 0 });
      expect(out.data.SalesPrice).toBe(0);
    });

    it("OMITS SalesPrice when retail_price is absent — never coerces to 0 (this is the bug that zeroed QB prices)", () => {
      const out = buildQbStepInput({ ...modBase, salesDescription: "desc only" });
      expect(out.data.SalesPrice).toBeUndefined();
    });

    it("a price-only edit is NOT skipped (triggers a QB dispatch)", () => {
      const out = buildQbStepInput({ ...modBase, retail_price: 55 });
      expect(out.skip).toBe(false);
    });

    it("an edit touching no QB-relevant field is skipped", () => {
      // No sku/desc/price/cost/etc — only a non-QB field (image_urls).
      const out = buildQbStepInput({
        id: "prod_1",
        variant_id: "var_1",
        qb_id: "80001BE4-1762203774",
        qb_edit_sequence: "1780010536",
        image_urls: ["x"],
      });
      expect(out.skip).toBe(true);
    });
  });

  describe("add (no qb_id)", () => {
    it("defaults SalesPrice to 0 so QB does not reject the create (error 3045)", () => {
      const out = buildQbStepInput({ ...base, item_type: "Inventory" });
      expect(out.action).toBe("add");
      expect(out.data.SalesPrice).toBe(0);
    });

    it("uses the provided retail_price on a create", () => {
      const out = buildQbStepInput({ ...base, retail_price: 42 });
      expect(out.data.SalesPrice).toBe(42);
    });
  });
});
