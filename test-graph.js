const { resolve } = require("path");
const { initialize } = require("@medusajs/framework/modules-sdk");

async function test() {
  const { query } = await initialize({ projectConfig: require("./medusa-config.js") });
  const { data } = await query.graph({
    entity: "product_category",
    fields: ["id", "handle", "parent_category_id"],
    filters: { handle: "led-strips-white" }
  });
  console.log("Handle query:", data);
  
  const { data: nullParent } = await query.graph({
    entity: "product_category",
    fields: ["id", "handle", "parent_category_id"],
    filters: { parent_category_id: "null" }
  });
  console.log("String null parent:", nullParent.length);
  
  const { data: realNull } = await query.graph({
    entity: "product_category",
    fields: ["id", "handle", "parent_category_id"],
    filters: { parent_category_id: null }
  });
  console.log("Actual null parent:", realNull.length);
}
test().catch(console.error);
