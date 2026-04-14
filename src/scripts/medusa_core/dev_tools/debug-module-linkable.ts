import { ExecArgs } from "@medusajs/framework/types";
import AttributeModule from "../modules/product-attributes";
import ProductModule from "@medusajs/medusa/product";

export default async function debugModuleLinkable({ container }: ExecArgs) {
  console.log("🔍 Inspecting Attribute Module Linkable Keys...");

  // Check Product Module
  if (ProductModule && ProductModule.linkable) {
    console.log(
      "✅ Product linkable keys:",
      Object.keys(ProductModule.linkable)
    );
    console.log(
      "🔍 Detail for product:",
      JSON.stringify(ProductModule.linkable.product, null, 2)
    );
  } else {
    console.error("❌ ProductModule.linkable is undefined!", ProductModule);
  }

  // AttributeModule is the default export from index.ts, which is the result of Module(...)
  if (AttributeModule && AttributeModule.linkable) {
    console.log(
      "✅ linkable keys found:",
      Object.keys(AttributeModule.linkable)
    );
    console.log(
      "🔍 Detail for attributeValue:",
      JSON.stringify(AttributeModule.linkable.attributeValue, null, 2)
    );
  } else {
    console.error("❌ AttributeModule.linkable is undefined!");
    console.log("Module export:", AttributeModule);
  }
}
