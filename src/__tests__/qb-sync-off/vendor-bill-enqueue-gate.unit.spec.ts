/**
 * The four purchase-orders QB enqueue helpers (vendor bill add/mod, bill
 * payment add/void, vendor credit add/void) must return `{queued:false,
 * reason:"QB_SYNC_ENABLED=false"}` WITHOUT issuing a single `knex.raw` call —
 * QB_VENDOR_BILL_MODE is checked right after, so the sync gate has to come
 * first or a fake knex would still see traffic.
 */
import { enqueueQbVendorBillAdd } from "../../lib/purchase-orders/qb-vendor-bill-enqueue";
import { enqueueVendorBillModSingle } from "../../lib/purchase-orders/qb-vendor-bill-mod-enqueue";
import {
  enqueueBillPaymentAdd,
  enqueueBillPaymentVoid,
} from "../../lib/purchase-orders/qb-bill-payment-enqueue";
import {
  enqueueVendorCreditAdd,
  enqueueVendorCreditVoid,
} from "../../lib/purchase-orders/qb-vendor-credit-enqueue";

function untouchedKnex() {
  return {
    raw: jest.fn(async () => {
      throw new Error("knex.raw called — gate did not fire before any SQL");
    }),
  };
}

describe("purchase-orders QB enqueue helpers — QB_SYNC_ENABLED=false", () => {
  const ORIGINAL_SYNC = process.env.QB_SYNC_ENABLED;
  const ORIGINAL_MODE = process.env.QB_VENDOR_BILL_MODE;

  beforeEach(() => {
    process.env.QB_SYNC_ENABLED = "false";
    // Deliberately leave QB_VENDOR_BILL_MODE=bill so a bug that checks the
    // flags in the wrong order would fall through to the knex.raw spy.
    process.env.QB_VENDOR_BILL_MODE = "bill";
  });

  afterEach(() => {
    if (ORIGINAL_SYNC === undefined) delete process.env.QB_SYNC_ENABLED;
    else process.env.QB_SYNC_ENABLED = ORIGINAL_SYNC;
    if (ORIGINAL_MODE === undefined) delete process.env.QB_VENDOR_BILL_MODE;
    else process.env.QB_VENDOR_BILL_MODE = ORIGINAL_MODE;
  });

  it("enqueueQbVendorBillAdd skips without touching knex", async () => {
    const knex = untouchedKnex();
    const result = await enqueueQbVendorBillAdd(knex as any, "vb_1");
    expect(result).toEqual({ queued: false, reason: "QB_SYNC_ENABLED=false" });
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it("enqueueVendorBillModSingle skips without touching knex", async () => {
    const knex = untouchedKnex();
    const result = await enqueueVendorBillModSingle(knex as any, "vb_1");
    expect(result).toEqual({ queued: false, reason: "QB_SYNC_ENABLED=false" });
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it("enqueueBillPaymentAdd skips without touching knex", async () => {
    const knex = untouchedKnex();
    const result = await enqueueBillPaymentAdd(knex as any, "vbp_1");
    expect(result).toEqual({ queued: false, reason: "QB_SYNC_ENABLED=false" });
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it("enqueueBillPaymentVoid skips without touching knex", async () => {
    const knex = untouchedKnex();
    const result = await enqueueBillPaymentVoid(knex as any, "vbp_1");
    expect(result).toEqual({ queued: false, reason: "QB_SYNC_ENABLED=false" });
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it("enqueueVendorCreditAdd skips without touching knex", async () => {
    const knex = untouchedKnex();
    const result = await enqueueVendorCreditAdd(knex as any, "vc_1");
    expect(result).toEqual({ queued: false, reason: "QB_SYNC_ENABLED=false" });
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it("enqueueVendorCreditVoid skips without touching knex", async () => {
    const knex = untouchedKnex();
    const result = await enqueueVendorCreditVoid(knex as any, "vc_1");
    expect(result).toEqual({ queued: false, reason: "QB_SYNC_ENABLED=false" });
    expect(knex.raw).not.toHaveBeenCalled();
  });
});
