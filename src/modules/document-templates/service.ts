/**
 * src/modules/document-templates/service.ts
 * Document template module service — delegates CRUD to MedusaService framework.
 * Business logic (set-default, duplicate) is handled in API routes.
 */

import { MedusaService } from "@medusajs/utils";
import PosDocumentTemplate from "./models/pos-document-template";

class DocumentTemplateModuleService extends MedusaService({
  PosDocumentTemplate,
}) {}

export default DocumentTemplateModuleService;
