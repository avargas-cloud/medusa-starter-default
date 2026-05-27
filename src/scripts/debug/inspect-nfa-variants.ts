import { ExecArgs } from "@medusajs/framework/types";

export default async function ({ container }: ExecArgs) {
  const query = container.resolve("query") as any;
  const ids = [
    "variant_01KSKF81WB2N5HWZZPEP22NJW2",
    "variant_01KSKF81WC0F8J00B3ES2T1VJJ",
    "variant_01KPXNHBFMY2985M0BMRDT3N9S",
  ];
  const { data } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "sku",
      "product.id",
      "product.handle",
      "product.status",
      "inventory_items.inventory.id",
      "inventory_items.inventory.sku",
      "price_set.id",
      "options.option.title",
      "options.value",
    ],
    filters: { id: ids },
  });
  for (const v of data) {
    console.log(JSON.stringify(v, null, 2));
  }
}
