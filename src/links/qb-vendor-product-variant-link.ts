import ProductModule from "@medusajs/medusa/product";
import { defineLink } from "@medusajs/utils";

import QuickbooksCatalogModule from "../modules/quickbooks-catalog";

export default defineLink(
  QuickbooksCatalogModule.linkable.qbVendor,
  { linkable: ProductModule.linkable.productVariant, isList: true }
);
