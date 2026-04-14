/**
 * src/modules/document-templates/index.ts
 * Module definition — register in medusa-config.ts as resolve: './src/modules/document-templates'
 */

import { Module } from "@medusajs/utils";

import DocumentTemplateModuleService from "./service";

export const DOCUMENT_TEMPLATE_MODULE = "document_templates";

export default Module(DOCUMENT_TEMPLATE_MODULE, {
  service: DocumentTemplateModuleService,
});
