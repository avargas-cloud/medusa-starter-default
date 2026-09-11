import {
  cartLinkMetadata,
  lineProvenance,
  normalizeBomLines,
  sourceKeyFor,
} from "../normalize";
import { MAX_BOM_LINES, SyncCartBomError } from "../types";

describe("normalizeBomLines", () => {
  it("conserva el orden, recorta el sku y suma cantidades del mismo SKU", () => {
    const lines = normalizeBomLines("backlighting", "proj_1", [
      { sku: " STRIP-24 ", quantity: 2 },
      { sku: "DRV-60", quantity: 1 },
      { sku: "STRIP-24", quantity: 3 },
    ]);
    expect(lines).toEqual([
      { sku: "STRIP-24", quantity: 5, sourceKey: "backlighting:proj_1:STRIP-24" },
      { sku: "DRV-60", quantity: 1, sourceKey: "backlighting:proj_1:DRV-60" },
    ]);
  });

  it("rechaza sku vacío, cantidad no entera, cero o negativa, y más de MAX líneas", () => {
    const bad = (lines: unknown) => () =>
      normalizeBomLines("linear-lighting", "llp_1", lines as never);
    expect(bad([{ sku: "", quantity: 1 }])).toThrow(SyncCartBomError);
    expect(bad([{ sku: "X", quantity: 1.5 }])).toThrow(SyncCartBomError);
    expect(bad([{ sku: "X", quantity: 0 }])).toThrow(SyncCartBomError);
    expect(bad([{ sku: "X", quantity: -2 }])).toThrow(SyncCartBomError);
    expect(bad("nope")).toThrow(SyncCartBomError);
    const tooMany = Array.from({ length: MAX_BOM_LINES + 1 }, (_, i) => ({
      sku: `S${i}`,
      quantity: 1,
    }));
    expect(bad(tooMany)).toThrow(/at most/);
  });

  it("un BOM vacío es válido (sincroniza a cero líneas)", () => {
    expect(normalizeBomLines("backlighting", "proj_1", [])).toEqual([]);
  });
});

describe("provenance y vínculo — las mismas claves que el POS", () => {
  it("lineProvenance etiqueta source_app / source_project_id / source_key", () => {
    const line = { sku: "DRV-60", quantity: 1, sourceKey: sourceKeyFor("backlighting", "p", "DRV-60") };
    expect(lineProvenance("backlighting", "p", line)).toEqual({
      source_app: "backlighting",
      source_project_id: "p",
      source_key: "backlighting:p:DRV-60",
      sku: "DRV-60",
    });
  });

  it("cartLinkMetadata usa las claves de set-bl-link / set-ll-link", () => {
    const now = new Date("2026-09-11T12:00:00.000Z");
    expect(cartLinkMetadata("backlighting", "proj_1", "BL-00123", now)).toEqual({
      backlighting_project_id: "proj_1",
      backlighting_seq_id: "BL-00123",
      backlighting_linked_at: "2026-09-11T12:00:00.000Z",
      backlighting_linked_by: "web",
      bom_source_app: "backlighting",
    });
    expect(cartLinkMetadata("linear-lighting", "llp_1", undefined, now)).toEqual({
      ll_project_id: "llp_1",
      ll_seq_id: null,
      ll_linked_at: "2026-09-11T12:00:00.000Z",
      ll_linked_by: "web",
      bom_source_app: "linear-lighting",
    });
  });
});
