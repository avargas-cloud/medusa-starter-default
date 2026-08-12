import {
  readVendorFullName,
  readVendorListId,
  vendorFullNameSql,
  vendorListIdSql,
  vendorMetadataPatch,
} from "../../lib/vendor-metadata/keys";

/**
 * The vendor metadata pair during the expand half of the rename.
 *
 * These are the semantics the POS edit workflows depend on: `undefined` must
 * survive so `pruneUndefined` still drops untouched fields, `null` must be
 * emitted so a cleared vendor actually clears, and every write must carry both
 * spellings so the pre-rename build reads the right value during the cutover.
 */
describe("vendor metadata keys — reads", () => {
  it("prefers the renamed key over the legacy one", () => {
    const meta = {
      vendor_full_name: "Luxury LED LLC",
      qb_vendor_full_name: "HK HELIAN OPTOELECTRONICS CO., LIMITED",
      vendor_list_id: "NEW-ID",
      qb_vendor_list_id: "OLD-ID",
    };
    expect(readVendorFullName(meta)).toBe("Luxury LED LLC");
    expect(readVendorListId(meta)).toBe("NEW-ID");
  });

  it("falls back to the legacy key while the migration has not reached a row", () => {
    const meta = { qb_vendor_full_name: "Luxury LED LLC", qb_vendor_list_id: "OLD-ID" };
    expect(readVendorFullName(meta)).toBe("Luxury LED LLC");
    expect(readVendorListId(meta)).toBe("OLD-ID");
  });

  it("treats blank and non-string values as absent, never as a vendor named ''", () => {
    expect(readVendorFullName({ vendor_full_name: "   " })).toBeNull();
    expect(readVendorFullName({ vendor_full_name: null })).toBeNull();
    expect(readVendorFullName({ vendor_full_name: 42 })).toBeNull();
    expect(readVendorFullName({})).toBeNull();
    expect(readVendorFullName(null)).toBeNull();
  });

  it("skips a blank renamed key in favour of a real legacy value", () => {
    expect(
      readVendorFullName({ vendor_full_name: "", qb_vendor_full_name: "Luxury LED LLC" })
    ).toBe("Luxury LED LLC");
  });
});

describe("vendor metadata keys — writes", () => {
  it("emits BOTH spellings from the same value", () => {
    expect(vendorMetadataPatch("Luxury LED LLC", "LID-1")).toEqual({
      vendor_full_name: "Luxury LED LLC",
      qb_vendor_full_name: "Luxury LED LLC",
      vendor_list_id: "LID-1",
      qb_vendor_list_id: "LID-1",
    });
  });

  it("preserves undefined so pruneUndefined still drops untouched fields", () => {
    const patch = vendorMetadataPatch(undefined, "LID-1");
    expect(patch.vendor_full_name).toBeUndefined();
    expect(patch.qb_vendor_full_name).toBeUndefined();
    expect(patch.vendor_list_id).toBe("LID-1");
    expect(patch.qb_vendor_list_id).toBe("LID-1");
  });

  it("emits null on BOTH names when clearing — omitting a key would keep the old value", () => {
    expect(vendorMetadataPatch(null, null)).toEqual({
      vendor_full_name: null,
      qb_vendor_full_name: null,
      vendor_list_id: null,
      qb_vendor_list_id: null,
    });
  });
});

describe("vendor metadata keys — SQL", () => {
  it("emits no bind placeholder — a `?` would shift every caller's binding count", () => {
    expect(vendorFullNameSql("p")).not.toContain("?");
    expect(vendorListIdSql("p")).not.toContain("?");
  });

  it("reads the renamed key first and the legacy one second", () => {
    const sql = vendorFullNameSql("p");
    expect(sql.indexOf("'vendor_full_name'")).toBeLessThan(
      sql.indexOf("'qb_vendor_full_name'")
    );
    expect(sql).toContain("p.metadata->>");
  });

  it("honours the alias it is given", () => {
    expect(vendorListIdSql("prod")).toContain("prod.metadata->>'vendor_list_id'");
  });
});
