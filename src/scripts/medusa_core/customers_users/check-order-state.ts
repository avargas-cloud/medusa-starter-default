import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

const ORDER_ID = "order_01KJV03YATCKZGG7ZRA1102RZF";

export default async function checkOrderState({ container }: ExecArgs) {
  const orderModule = container.resolve(Modules.ORDER) as any;
  const inventoryModule = container.resolve(Modules.INVENTORY) as any;

  // ── 1. Check order is_draft_order status ────────────────────────────────
  console.log(`\n🔍 Checking order: ${ORDER_ID}`);
  try {
    const [orders] = await orderModule.listAndCountOrders(
      { id: ORDER_ID },
      { select: ["id", "status", "is_draft_order", "display_id"] }
    );
    if (!orders?.length) {
      console.log("  ❌ Order not found!");
    } else {
      const o = orders[0];
      const isDraft = o.is_draft_order;
      console.log(`  display_id    : #${o.display_id}`);
      console.log(`  status        : ${o.status}`);
      console.log(`  is_draft_order: ${isDraft}`);
      if (!isDraft) {
        console.log(
          "  ⚠️  ORDER IS ALREADY CONVERTED — navigate to /app/orders to find it!"
        );
      } else {
        console.log("  ✅ Still a draft order — conversion not yet completed");
      }
    }
  } catch (e: any) {
    console.error("  Error reading order:", e?.message);
  }

  // ── 2. Sample inventory items with explicit select ───────────────────────
  console.log("\n📦 Sampling allow_backorder from DB (explicit select):");
  try {
    const [items] = await inventoryModule.listAndCountInventoryItems(
      {},
      {
        take: 10,
        skip: 0,
        select: ["id", "sku", "allow_backorder"],
      }
    );
    let trueCount = 0;
    let falseCount = 0;
    let undefinedCount = 0;
    for (const item of items) {
      const icon =
        item.allow_backorder === true
          ? "✅"
          : item.allow_backorder === false
            ? "❌"
            : "❓";
      if (item.allow_backorder === true) trueCount++;
      else if (item.allow_backorder === false) falseCount++;
      else undefinedCount++;
      console.log(
        `  ${icon} ${item.sku || item.id}: allow_backorder=${item.allow_backorder}`
      );
    }
    console.log(
      `\n  Summary (sample of 10): true=${trueCount} false=${falseCount} undefined=${undefinedCount}`
    );
  } catch (e: any) {
    console.error("  Error reading inventory:", e?.message);
  }
}
