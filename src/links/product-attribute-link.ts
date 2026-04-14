import ProductModule from "@medusajs/medusa/product";
import { defineLink } from "@medusajs/utils";

import AttributeModule from "../modules/product-attributes";

export default defineLink(
  { linkable: ProductModule.linkable.product, isList: true },
  { linkable: AttributeModule.linkable.attributeValue, isList: true }
);
