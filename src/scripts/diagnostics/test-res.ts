import { MedusaContainer } from "@medusajs/framework/types";

export default async function testRes({
  container,
}: {
  container: MedusaContainer;
}) {
  const query = container.resolve("query");

  console.log("Testing Reservations...");
  try {
    const { data } = await query.graph({
      entity: "reservation",
      fields: ["*"],
      filters: { line_item_id: ["ordli_01KMGWYHBMH3XQ0EZ4JXM0WXRB"] },
    });
    console.log("Reservations from graph:", JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.error("Graph error:", e.message);
  }

  try {
    const inv = container.resolve("inventory");
    const res = await inv.listReservationItems({
      line_item_id: ["ordli_01KMGWYHBMH3XQ0EZ4JXM0WXRB"],
    });
    console.log(
      "Reservations from module (array):",
      JSON.stringify(res, null, 2)
    );
  } catch (e: any) {
    console.error("Module error:", e.message);
  }
}
