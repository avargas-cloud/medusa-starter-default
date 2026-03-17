const { initialize } = require('@medusajs/framework/utils');
async function test() {
  const { container } = await initialize({ require: false });
  const query = container.resolve("query");
  const { data: [fetchedOrder] } = await query.graph({
      entity: "order",
      fields: ["id", "display_id", "subtotal", "discount_total", "tax_total", "total", "sales_channel_id"],
      filters: { display_id: 1119 }
  });
  console.log(JSON.stringify(fetchedOrder, null, 2));
  process.exit(0);
}
test().catch(console.error);
