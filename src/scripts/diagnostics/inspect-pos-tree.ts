import { MedusaContainer } from "@medusajs/medusa";

// ─── POS Total Engine ──────────────────────────────────────────────────────────
// Mirrors frontend computeTotals() in store/posStore.ts exactly.
// Key difference vs Medusa native: tax rounds on the AGGREGATE taxable base
// (Math.round), not per-line. This avoids $0.01 rounding discrepancies.
function posComputeTotals(order: any): {
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
} {
  const items = (order.items || []) as any[];

  // Determine tax mode from Medusa tax_lines (rate 0 = exempt)
  const taxRate = items.some((i: any) => (i.tax_lines?.[0]?.rate ?? 0) > 0)
    ? 0.07
    : 0;

  let originalSubtotalCents = 0;
  let afterLineDiscountsCents = 0;

  for (const item of items) {
    const unitCents = Math.round(Number(item.unit_price || 0) * 100);
    const qty = item.quantity || 1;
    const baseCents = unitCents * qty;
    originalSubtotalCents += baseCents;

    // Adjustments = per-item discounts (promotions, etc.)
    const adjCents = (item.adjustments || []).reduce(
      (s: number, a: any) => s + Math.round(Number(a.amount || 0) * 100),
      0
    );
    afterLineDiscountsCents += baseCents - adjCents;
  }

  // Order-level discount_total from Medusa (already in dollars from query.graph)
  const orderDiscountCents = Math.round(
    Number(order.discount_total || 0) * 100
  );
  const taxableAmountCents = Math.max(
    0,
    afterLineDiscountsCents - orderDiscountCents
  );

  // POS formula: round tax on aggregate (NOT per-line), matching Math.round behavior
  const taxCents = Math.round(taxableAmountCents * taxRate);

  const shippingCents = (order.shipping_methods || []).reduce(
    (s: number, sm: any) => s + Math.round(Number(sm.amount || 0) * 100),
    0
  );

  const totalCents = taxableAmountCents + shippingCents + taxCents;

  return {
    subtotal: originalSubtotalCents / 100,
    discount: orderDiscountCents / 100,
    shipping: shippingCents / 100,
    tax: taxCents / 100,
    total: totalCents / 100,
  };
}

export default async function inspectPosTree({
  container,
}: {
  container: MedusaContainer;
}) {
  const query = container.resolve("query") as any;
  const inventoryModule = container.resolve("inventory", {
    allowUnregistered: true,
  }) as any;
  const args = process.argv.slice(2);
  const queryId = args.find(
    (a) =>
      !a.startsWith("-") &&
      a !== "exec" &&
      !a.endsWith(".ts") &&
      !a.endsWith(".js")
  );

  if (!queryId) {
    console.error(
      "❌ Please provide an ID (order_*, dord_*, inv_*, pay_*, papp_*, cm_*, or numeric display_id)."
    );
    console.error(
      "Example: npx tsx src/scripts/diagnostics/inspect-pos-tree.ts 1533"
    );
    process.exit(1);
  }

  let orderId: string | undefined;
  const isNumeric = /^\d+$/.test(queryId);

  console.log(`\n🔍 Resolving ID: ${queryId} ...`);

  try {
    if (
      isNumeric ||
      queryId.startsWith("order_") ||
      queryId.startsWith("dord_")
    ) {
      // It's an order ID or display_id
      const filters = isNumeric
        ? { display_id: parseInt(queryId) }
        : { id: queryId };
      const {
        data: [order],
      } = await query.graph({ entity: "order", fields: ["id"], filters });
      if (!order) throw new Error(`Order ${queryId} not found`);
      orderId = order.id;
    } else if (queryId.startsWith("inv_")) {
      const {
        data: [inv],
      } = await query.graph({
        entity: "pos_invoice",
        fields: ["order_id"],
        filters: { id: queryId },
      });
      if (!inv) throw new Error(`Invoice ${queryId} not found`);
      orderId = inv.order_id;
    } else if (queryId.startsWith("papp_")) {
      const {
        data: [app],
      } = await query.graph({
        entity: "payment_application",
        fields: ["order_id"],
        filters: { id: queryId },
      });
      if (!app) throw new Error(`Application ${queryId} not found`);
      orderId = app.order_id;
    } else if (queryId.startsWith("pay_")) {
      const {
        data: [app],
      } = await query.graph({
        entity: "payment_application",
        fields: ["order_id"],
        filters: { payment: { id: queryId } },
      });
      if (!app)
        throw new Error(`No payment application found for Payment ${queryId}`);
      orderId = app.order_id;
    } else if (queryId.startsWith("cm_")) {
      const {
        data: [cm],
      } = await query.graph({
        entity: "pos_credit_memo",
        fields: ["order_id"],
        filters: { id: queryId },
      });
      if (!cm) throw new Error(`Credit Memo ${queryId} not found`);
      orderId = cm.order_id;
    } else {
      throw new Error(`Unknown ID format: ${queryId}`);
    }

    console.log(`✅ Resolved to Order ID: ${orderId}\n`);

    // Fetch the Order Tree
    const {
      data: [order],
    } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "status",
        "payment_status",
        "fulfillment_status",
        "version",
        "total",
        "subtotal",
        "tax_total",
        "discount_total",
        "metadata",
        "created_at",
        "updated_at",
        "customer.*",
        "shipping_address.*",
        "items.*",
        "items.tax_lines.*",
        "items.adjustments.*",
        "fulfillments.*",
        "fulfillments.labels.*",
        "payment_collections.*",
        "shipping_methods.*",
      ],
      filters: { id: orderId },
    });

    if (!order) {
      console.log(`❌ Order ${orderId} missing data!`);
      return;
    }

    // Fetch Custom Modules
    const { data: invoices } = await query
      .graph({
        entity: "pos_invoice",
        fields: ["*", "items.*", "tracking_links.*"],
        filters: { order_id: orderId },
      })
      .catch(() => ({ data: [] }));

    const { data: applications } = await query
      .graph({
        entity: "payment_application",
        fields: ["*", "payment.*"],
        filters: { order_id: orderId },
      })
      .catch(() => ({ data: [] }));

    const { data: creditMemos } = await query
      .graph({
        entity: "pos_credit_memo",
        fields: ["*", "items.*"],
        filters: { order_id: orderId },
      })
      .catch(() => ({ data: [] }));

    // Inventory matching
    let reservations: any[] = [];
    const activeItems =
      order.items?.filter(
        (i: any) =>
          i.version === order.version || i.detail?.version === order.version
      ) || [];
    if (inventoryModule && activeItems.length) {
      try {
        const lineItemIds = activeItems.map(
          (i: any) => i.detail?.item_id || i.id
        );
        reservations = await inventoryModule.listReservationItems({
          line_item_id: lineItemIds,
        });
      } catch (e) {
        // Ignored
      }
    }

    // Use POS totals engine (not Medusa native) to avoid $0.01 rounding on half-cent tax values.
    const pos = posComputeTotals(order);

    console.log("=========================================");
    console.log(`📦 ORDER (${order.id}) | # ${order.display_id}`);
    console.log(
      `   Status: ${String(order.status || "UNKNOWN").toUpperCase()} | Fulfillment: ${String(order.fulfillment_status || "UNKNOWN").toUpperCase()} | Payment: ${String(order.payment_status || "UNKNOWN").toUpperCase()}`
    );
    console.log(`   Subtotal: $${pos.subtotal.toFixed(2)}`);

    if (pos.discount > 0) {
      console.log(`   Discounts: -$${pos.discount.toFixed(2)}`);
    }

    if (order.shipping_methods?.length) {
      order.shipping_methods.forEach((sm: any) => {
        console.log(
          `   Shipping (${sm.name || "Generic"}): +$${Number(sm.amount || 0).toFixed(2)}`
        );
      });
    } else {
      console.log(`   Shipping: None`);
    }

    console.log(
      `   Taxes: $${pos.tax.toFixed(2)}  (Medusa native: $${Number(order.tax_total || 0).toFixed(2)}${pos.tax !== Number(order.tax_total || 0) ? " ⚠️ rounding diff" : ""})`
    );
    console.log(
      `   GRAND TOTAL: $${pos.total.toFixed(2)}  ← POS authoritative`
    );
    console.log("");

    console.log("   📝 ITEMS:");
    activeItems.forEach((item: any) => {
      const taxRate = item.tax_lines?.[0]?.rate || 0;
      const lineItemIdToMatch = item.detail?.item_id || item.id;
      const itemReservations = reservations.filter(
        (r) => r.line_item_id === lineItemIdToMatch
      );
      const allocatedQty = itemReservations.reduce(
        (acc, r) => acc + (r.quantity || 0),
        0
      );
      const fulQty =
        item.detail?.fulfilled_quantity ?? (item.fulfilled_quantity || 0);

      const backorderQty = item.quantity - fulQty;
      console.log(
        `     - [${item.variant_sku || "N/A"}] ${item.title} (x${item.quantity})`
      );
      console.log(
        `       Price: $${Number(item.unit_price || 0).toFixed(2)} (Tax: ${taxRate}%)`
      );
      console.log(
        `       Status: Qty: ${item.quantity} | Fulfilled: ${fulQty} | Allocated: ${allocatedQty} | Backorder: ${backorderQty}`
      );
      if (order.status !== "draft" && backorderQty !== allocatedQty) {
        console.log(
          `       ⚠️ ALLOCATION MISMATCH: Medusa reserved ${allocatedQty} but ${backorderQty} are pending!`
        );
      }

      if (item.adjustments?.length) {
        item.adjustments.forEach((adj: any) => {
          console.log(
            `       🎁 Discount [${adj.code}]: -$${Number(adj.amount || 0).toFixed(2)}`
          );
        });
      }
    });

    console.log("\n└── 🚚 FULFILLMENTS");
    if (order.fulfillments?.length) {
      order.fulfillments.forEach((f: any) => {
        const trackingLabels =
          f.labels?.map((l: any) => l.tracking_number).filter(Boolean) || [];
        const allTracking = [...new Set([...trackingLabels])].join(", ");
        const trackingStr = allTracking ? ` | Tracking: ${allTracking}` : "";
        console.log(
          `    ├── Fulfillment (${f.id}) - Provider: ${f.provider_id || "Unknown"}${trackingStr}`
        );
      });
    } else {
      console.log("    ├── No fulfillments yet");
    }

    console.log("\n└── 🧾 INVOICES");
    let invoiceSum = 0;
    if (invoices?.length) {
      invoices.forEach((inv: any) => {
        const invTotal = Number(inv.total || 0) / 100;
        const invPaid = Number(inv.amount_paid || 0) / 100;
        const invDue = Number(inv.balance_due || 0) / 100;
        const invShipping = Number(inv.shipping || 0) / 100;
        invoiceSum += invTotal;
        console.log(`    ├── Invoice (${inv.id}) | # ${inv.invoice_number}`);
        console.log(
          `    │   Status: ${inv.status.toUpperCase()} | Total: $${invTotal.toFixed(2)} | Shipping: $${invShipping.toFixed(2)} | Paid: $${invPaid.toFixed(2)} | Due: $${invDue.toFixed(2)}`
        );
        if (inv.items?.length) {
          inv.items.forEach((item: any) => {
            console.log(
              `    │     - [${item.sku || "N/A"}] ${item.description || "Item"} (x${item.quantity}) @ $${(Number(item.unit_price || 0) / 100).toFixed(2)}`
            );
          });
        }
      });
    } else {
      console.log("    ├── No POS invoices found");
    }

    console.log("\n└── 💳 FINANCE & PAYMENTS");
    let appliedSum = 0;
    if (applications?.length) {
      applications.forEach((app: any) => {
        const amtApp = Number(app.amount_applied || 0) / 100;
        let isVoided = app.voided_at != null;
        if (!isVoided) appliedSum += amtApp;

        console.log(
          `    ├── Application (${app.id}) ${isVoided ? "[VOID]" : ""} -> Applied: $${amtApp.toFixed(2)}`
        );
        if (app.payment) {
          console.log(
            `    │   From Payment (${app.payment.id}) | Method: ${app.payment.method} | Status: ${app.payment.status}`
          );
        }
      });
    } else {
      console.log("    ├── No payment applications found");
    }

    console.log("\n└── 🔄 CREDIT MEMOS");
    let cmSum = 0;
    if (creditMemos?.length) {
      creditMemos.forEach((cm: any) => {
        const cmTotal = Number(cm.total || 0) / 100;
        cmSum += cmTotal;
        console.log(
          `    ├── Credit Memo (${cm.id}) | # ${cm.credit_memo_number}`
        );
        console.log(
          `    │   Status: ${cm.status.toUpperCase()} | Total Refund: -$${cmTotal.toFixed(2)}`
        );
        if (cm.items?.length) {
          cm.items.forEach((item: any) => {
            console.log(
              `    │     - [${item.sku || "N/A"}] ${item.description || "Item"} (x${item.quantity}) @ $${(Number(item.unit_price || 0) / 100).toFixed(2)}`
            );
          });
        }
      });
    } else {
      console.log("    ├── No credit memos found");
    }

    console.log("\n=========================================");
    console.log("📊 VALIDATION SUMMARY");
    console.log(
      `Order Total (POS):    $${pos.total.toFixed(2)}  ← used for all comparisons`
    );
    console.log(
      `Order Total (Medusa): $${Number(order.total || 0).toFixed(2)}  (native — may differ by $0.01 on half-cent tax)`
    );
    console.log(`Invoiced Total:       $${invoiceSum.toFixed(2)}`);
    console.log(`Payments Applied:     $${appliedSum.toFixed(2)}`);
    console.log(`Credits Issued:       -$${cmSum.toFixed(2)}`);

    // Quick Math Checks — always compare against POS total
    const diffInv = Math.abs(pos.total - invoiceSum);
    if (diffInv < 0.015 && invoices?.length > 0) {
      console.log("✅ Order fully invoiced matching total.");
    } else if (invoices?.length === 0) {
      console.log("⏳ Order not yet invoiced.");
    } else {
      console.log(
        `⚠️ Invoice total mismatch vs Order total ($${diffInv.toFixed(2)} off).`
      );
    }

    const diffPay = Math.abs(pos.total - appliedSum);
    if (diffPay < 0.015) {
      console.log("✅ Payments fully applied matching total.");
    } else {
      console.log(
        `⏳ Payment balance mismatch: $${(pos.total - appliedSum).toFixed(2)} remaining.`
      );
    }

    console.log("=========================================\n");
  } catch (error: any) {
    console.error(`\n❌ Error inspecting tree: ${error.message}`);
  }
}
