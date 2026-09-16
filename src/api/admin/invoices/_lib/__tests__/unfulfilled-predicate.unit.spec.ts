import { hasGoodsSql, linkedToOrderSql, unfulfilledSql } from "../unfulfilled-predicate";

/**
 * The predicate is a SQL string, so the assertions are structural: the goods
 * clause must GATE the whole thing (an empty order can never be unfulfilled),
 * and nothing in the output may carry a `?` — knex's `raw` would read it as a
 * positional binding.
 */
const cols = {
  fulfillmentId: "i.fulfillment_id",
  canceledAt: "f.canceled_at",
  shippedAt: "f.shipped_at",
  deliveredAt: "f.delivered_at",
  hasTracking: "has_tracking",
  linkedToOrder: linkedToOrderSql("i"),
  hasGoods: hasGoodsSql("i"),
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("unfulfilledSql", () => {
  it("gates every 'still unfulfilled' clause behind hasGoods (2026-09-16)", () => {
    const sql = squash(unfulfilledSql(cols));
    // `( <hasGoods> AND ( ...clauses... ) )` — the goods test is the first operand.
    expect(sql.startsWith(`( ${squash(cols.hasGoods)} AND (`)).toBe(true);
    expect(sql).toContain("i.fulfillment_id IS NULL");
    expect(sql).toContain("f.canceled_at IS NOT NULL");
    expect(sql).toContain(`NOT ${squash(cols.linkedToOrder)}`);
  });

  it("hasGoods reads the order's CURRENT version with quantity > 0", () => {
    const sql = squash(hasGoodsSql("i"));
    expect(sql).toContain("oig.version = og.version");
    expect(sql).toContain("oig.quantity > 0");
    expect(sql).toContain("og.id = i.order_id");
  });

  it("emits no `?` anywhere (knex raw would bind it)", () => {
    expect(unfulfilledSql(cols)).not.toContain("?");
    expect(hasGoodsSql("i")).not.toContain("?");
    expect(linkedToOrderSql("i")).not.toContain("?");
  });
});
