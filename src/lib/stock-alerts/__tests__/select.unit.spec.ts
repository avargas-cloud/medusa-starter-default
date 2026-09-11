import {
  buildBackInStockEmail,
  selectAlertsToNotify,
  type PendingStockAlert,
} from "../select";

const alert = (over: Partial<PendingStockAlert> = {}): PendingStockAlert => ({
  id: "sa_1",
  customer_id: "cus_1",
  email: "c@example.test",
  variant_id: "variant_a",
  sku: "SKU-A",
  notified_at: null,
  canceled_at: null,
  ...over,
});

describe("selectAlertsToNotify", () => {
  it("avisa sólo cuando la variante tiene disponibilidad > 0", () => {
    const out = selectAlertsToNotify(
      [
        alert({ id: "1", variant_id: "variant_a" }),
        alert({ id: "2", variant_id: "variant_b" }),
      ],
      { variant_a: 3, variant_b: 0 }
    );
    expect(out.map((a) => a.id)).toEqual(["1"]);
  });

  it("una variante sin dato de disponibilidad no se avisa (null / ausente / NaN)", () => {
    const out = selectAlertsToNotify(
      [
        alert({ id: "1", variant_id: "v1" }),
        alert({ id: "2", variant_id: "v2" }),
        alert({ id: "3", variant_id: "v3" }),
      ],
      { v1: null, v3: Number.NaN }
    );
    expect(out).toEqual([]);
  });

  it("notificadas o canceladas nunca vuelven a salir aunque haya stock", () => {
    const out = selectAlertsToNotify(
      [
        alert({ id: "1", notified_at: "2026-09-11T00:00:00Z" }),
        alert({ id: "2", canceled_at: "2026-09-11T00:00:00Z" }),
        alert({ id: "3" }),
      ],
      { variant_a: 10 }
    );
    expect(out.map((a) => a.id)).toEqual(["3"]);
  });
});

describe("buildBackInStockEmail", () => {
  it("nombra el producto y el SKU, linkea la ficha y escapa HTML", () => {
    const mail = buildBackInStockEmail({
      productTitle: "90W <EASYLED> Driver",
      sku: "EAS1-D9024",
      productUrl: "https://ecopowertech.com/product/90w-easyled-driver",
      storeName: "EcoPowerTech",
    });
    expect(mail.subject).toBe(
      "90W <EASYLED> Driver is back in stock – EcoPowerTech"
    );
    expect(mail.html).toContain("90W &lt;EASYLED&gt; Driver");
    expect(mail.html).toContain("EAS1-D9024");
    expect(mail.html).toContain(
      'href="https://ecopowertech.com/product/90w-easyled-driver"'
    );
    expect(mail.html).not.toContain("quote");
  });

  it("sin ficha pública no inventa link", () => {
    const mail = buildBackInStockEmail({
      productTitle: "",
      sku: "X-1",
      productUrl: null,
      storeName: "EcoPowerTech",
    });
    expect(mail.subject).toBe("X-1 is back in stock – EcoPowerTech");
    expect(mail.html).not.toContain("<a ");
  });
});
