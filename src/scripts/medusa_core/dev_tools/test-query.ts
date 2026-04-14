import { ExecArgs } from "@medusajs/framework/types";

export default async function testQuery({ container }: ExecArgs) {
  const query = container.resolve("query");
  const { data } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "title",
      "variants.id",
      "variants.title",
      "variants.sku",
      "variants.price_set.prices.amount",
      "variants.price_set.prices.currency_code",
      "variants.price_set.prices.price_list_id",
    ],
    pagination: { skip: 0, take: 1 },
  });
  console.log(JSON.stringify(data, null, 2));
}
