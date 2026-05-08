/**
 * src/api/admin/document-templates/route.ts
 * GET  /admin/document-templates          — list all (filterable by doc_type)
 * POST /admin/document-templates          — create new template
 *
 * Uses direct pg Client (same pattern as system-defaults) to bypass ORM issues.
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import { generateId } from "../../../modules/document-templates/generate-id";

const DB = () =>
  new Client({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_URL?.includes("railway") ||
      process.env.DATABASE_URL?.includes("ssl") ||
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  });

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const db = DB();
  try {
    await db.connect();
    const { doc_type } = req.query as { doc_type?: string };

    let query = "SELECT * FROM pos_document_template";
    const params: any[] = [];

    if (
      doc_type &&
      [
        "estimate",
        "order",
        "invoice",
        "purchase_order",
        "purchase_order_receipt",
        "factory_order",
        "return",
        "statement",
        "payment",
      ].includes(doc_type)
    ) {
      query += " WHERE doc_type = $1";
      params.push(doc_type);
    }

    query += " ORDER BY created_at ASC";

    const result = await db.query(query, params);
    return res.json({ templates: result.rows });
  } catch (err) {
    console.error("[DocumentTemplates] GET list error:", err);
    return res.status(500).json({ error: "Failed to list templates" });
  } finally {
    await db.end();
  }
};

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const db = DB();
  try {
    await db.connect();
    const body = req.body as {
      name: string;
      doc_type:
        | "estimate"
        | "order"
        | "invoice"
        | "purchase_order"
        | "purchase_order_receipt"
        | "factory_order"
        | "return"
        | "statement"
        | "payment";
      field_config?: Record<string, any>;
      layout_data?: any[];
      is_default?: boolean;
      thumbnail?: string;
      created_by?: string;
    };

    if (!body.name || !body.doc_type) {
      return res.status(400).json({ error: "name and doc_type are required" });
    }

    const id = generateId();
    const now = new Date().toISOString();

    // If setting as default, clear others first
    if (body.is_default) {
      await db.query(
        "UPDATE pos_document_template SET is_default = false WHERE doc_type = $1",
        [body.doc_type]
      );
    }

    const result = await db.query(
      `INSERT INTO pos_document_template
             (id, name, doc_type, is_default, thumbnail, field_config, layout_data, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
      [
        id,
        body.name,
        body.doc_type,
        body.is_default ?? false,
        body.thumbnail ?? null,
        JSON.stringify(body.field_config ?? {}),
        JSON.stringify(body.layout_data ?? []),
        body.created_by ?? null,
        now,
        now,
      ]
    );

    return res.status(201).json({ template: result.rows[0] });
  } catch (err) {
    console.error("[DocumentTemplates] POST create error:", err);
    return res.status(500).json({ error: "Failed to create template" });
  } finally {
    await db.end();
  }
};
