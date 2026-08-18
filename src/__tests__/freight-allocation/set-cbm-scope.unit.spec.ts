/**
 * PATCH /admin/vendor-bills/:id/lines/:lineId/set-cbm — write scope.
 *
 * A LOCAL bill (no service/freight/tariff sibling) writes ONLY
 * `vendor_bill_line.cbm_per_unit` — a local purchase's CBM is a per-shipment
 * estimate (eyeballing the box), and pushing it onto `product_variant`
 * would leak that estimate into unrelated future purchases of the same SKU.
 *
 * A CHINA bill (any sibling pointer set) writes BOTH the line AND the
 * product — a China SKU is repurchased and its CBM is a real catalog fact
 * meant to be reused.
 *
 * Driven through the REAL exported `PATCH` handler with a fake req/res and a
 * fake `req.scope.resolve` (knex + the module service) — asserting on a
 * re-implementation of the branch would prove nothing about what the route
 * actually does.
 */

import { PATCH } from "../../api/admin/vendor-bills/[id]/lines/[lineId]/set-cbm/route";
import { PURCHASE_ORDERS_MODULE } from "../../modules/purchase-orders";

interface BillFixture {
  status: string;
  service_vendor_bill_id: string | null;
  freight_vendor_bill_id: string | null;
  tariff_vendor_bill_id: string | null;
}

function buildReqRes(bill: BillFixture) {
  const rawCalls: Array<{ sql: string; bindings: unknown[] }> = [];

  const knex = {
    raw: async (sql: string, bindings?: unknown[]) => {
      rawCalls.push({ sql, bindings: bindings ?? [] });
      const q = sql.replace(/\s+/g, " ");
      if (q.includes("SELECT * FROM vendor_bill_line WHERE id")) {
        return { rows: [{ id: "line_1", cbm_per_unit: bindings?.[0] }] };
      }
      return { rows: [] };
    },
  };

  const service = {
    listVendorBillLines: async () => [
      { id: "line_1", vendor_bill_id: "vb_1", product_variant_id: "variant_1" },
    ],
    listVendorBills: async () => [{ id: "vb_1", ...bill }],
  };

  const req = {
    params: { id: "vb_1", lineId: "line_1" },
    body: { cbm: 2.5 },
    scope: {
      resolve: (key: string) => {
        if (key === "__pg_connection__") return knex;
        if (key === PURCHASE_ORDERS_MODULE) return service;
        throw new Error(`unexpected resolve key: ${key}`);
      },
    },
  };

  let statusCode = 200;
  let body: unknown = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: unknown) => {
      body = payload;
      return res;
    },
  };

  const productVariantWrites = () =>
    rawCalls.filter((c) => c.sql.includes("UPDATE product_variant"));
  const billLineWrites = () =>
    rawCalls.filter((c) => c.sql.includes("UPDATE vendor_bill_line"));

  return {
    req,
    res,
    getStatus: () => statusCode,
    getBody: () => body as { scope?: string } | null,
    productVariantWrites,
    billLineWrites,
  };
}

describe("PATCH set-cbm — local vs China write scope", () => {
  it("local bill (all three sibling pointers NULL): writes ONLY the bill line, never the product", async () => {
    const h = buildReqRes({
      status: "draft",
      service_vendor_bill_id: null,
      freight_vendor_bill_id: null,
      tariff_vendor_bill_id: null,
    });

    await PATCH(h.req as never, h.res as never);

    expect(h.getStatus()).toBe(200);
    expect(h.billLineWrites().length).toBe(1);
    expect(h.productVariantWrites().length).toBe(0);
    expect(h.getBody()?.scope).toBe("bill_line");
  });

  it("China bill (freight_vendor_bill_id set): writes BOTH the bill line and the product", async () => {
    const h = buildReqRes({
      status: "draft",
      service_vendor_bill_id: null,
      freight_vendor_bill_id: "vb_freight_1",
      tariff_vendor_bill_id: null,
    });

    await PATCH(h.req as never, h.res as never);

    expect(h.getStatus()).toBe(200);
    expect(h.billLineWrites().length).toBe(1);
    expect(h.productVariantWrites().length).toBe(1);
    expect(h.getBody()?.scope).toBe("bill_line_and_product");
  });

  it("China bill via service_vendor_bill_id alone still counts as China", async () => {
    const h = buildReqRes({
      status: "draft",
      service_vendor_bill_id: "vb_service_1",
      freight_vendor_bill_id: null,
      tariff_vendor_bill_id: null,
    });

    await PATCH(h.req as never, h.res as never);

    expect(h.productVariantWrites().length).toBe(1);
    expect(h.getBody()?.scope).toBe("bill_line_and_product");
  });

  it("confirmed bill (any shape): still 409s before writing anything — the draft-only guard is untouched", async () => {
    const h = buildReqRes({
      status: "confirmed",
      service_vendor_bill_id: "vb_service_1",
      freight_vendor_bill_id: null,
      tariff_vendor_bill_id: null,
    });

    await PATCH(h.req as never, h.res as never);

    expect(h.getStatus()).toBe(409);
    expect(h.billLineWrites().length).toBe(0);
    expect(h.productVariantWrites().length).toBe(0);
  });
});
