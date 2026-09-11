import { buildListVendorCreditsQuery } from "../list-query";

describe("buildListVendorCreditsQuery", () => {
  it("with no filters: only deleted_at IS NULL, limit/offset as the last 2 params", () => {
    const { sql, params } = buildListVendorCreditsQuery({ limit: 50, offset: 0 });
    expect(sql).toContain("vc.deleted_at IS NULL");
    expect(sql).not.toContain("vc.vendor_id =");
    expect(sql).not.toContain("vc.status =");
    expect(sql).not.toContain("ILIKE");
    expect(params).toEqual([50, 0]);
    expect(sql).toContain("LIMIT $1 OFFSET $2");
  });

  it("adds vendor_id and status as separate $n binds, in order", () => {
    const { sql, params } = buildListVendorCreditsQuery({
      vendorId: "qbv_1",
      status: "posted",
      limit: 25,
      offset: 10,
    });
    expect(sql).toContain("vc.vendor_id = $1");
    expect(sql).toContain("vc.status = $2");
    expect(params).toEqual(["qbv_1", "posted", 25, 10]);
    expect(sql).toContain("LIMIT $3 OFFSET $4");
  });

  it("q reuses ONE bind across all 6 ILIKE columns (incl. PO and bill number), wrapped in %...%", () => {
    const { sql, params } = buildListVendorCreditsQuery({ q: "ADI", limit: 50, offset: 0 });
    expect(params).toEqual(["%ADI%", 50, 0]);
    expect(sql).toContain("vc.number ILIKE $1");
    expect(sql).toContain("vc.vendor_name_snapshot ILIKE $1");
    expect(sql).toContain("vc.reason ILIKE $1");
    expect(sql).toContain("vc.memo ILIKE $1");
    expect(sql).toContain("po.number ILIKE $1");
    expect(sql).toContain("vb.number ILIKE $1");
  });

  it("always LEFT JOINs the linked PO and bill (read-only) and selects their numbers", () => {
    const { sql } = buildListVendorCreditsQuery({ limit: 50, offset: 0 });
    expect(sql).toContain("LEFT JOIN purchase_order po ON po.id = vc.purchase_order_id");
    expect(sql).toContain("LEFT JOIN vendor_bill vb ON vb.id = vc.vendor_bill_id");
    expect(sql).toContain("po.number AS po_number");
    expect(sql).toContain("vb.number AS vendor_bill_number");
  });

  it("combines vendor_id + status + q with correct param indices", () => {
    const { sql, params } = buildListVendorCreditsQuery({
      vendorId: "qbv_1",
      status: "posted",
      q: "restock",
      limit: 50,
      offset: 0,
    });
    expect(sql).toContain("vc.vendor_id = $1");
    expect(sql).toContain("vc.status = $2");
    expect(sql).toContain("vc.number ILIKE $3");
    expect(params).toEqual(["qbv_1", "posted", "%restock%", 50, 0]);
    expect(sql).toContain("LIMIT $4 OFFSET $5");
  });

  it("always LEFT JOIN LATERALs applied_to (no N+1)", () => {
    const { sql } = buildListVendorCreditsQuery({ limit: 50, offset: 0 });
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql).toContain("json_agg(");
    expect(sql).toContain("'bill_number', avb.number");
    expect(sql).toContain("ca.voided_at IS NULL");
    expect(sql).toContain("COALESCE(applied.applied_to, '[]'::json) AS applied_to");
  });
});
