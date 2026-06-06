/**
 * src/modules/trip-objectives/defaults.ts
 *
 * Seed definitions for the three default objective types. Field keys are STABLE
 * — never rename once data exists (objective.fields is keyed by them). Lighting
 * specs (lumens, lumens/ft, watts, input/output voltage, …) are `optional:true`
 * so they're addable per-entry: a product fills only the specs that apply.
 *
 * The visual field builder edits these schemas at runtime via the categories
 * route; this file is only the initial seed.
 */

import type { FieldDef, ObjectiveGroup, StatusDef } from "./types";

const g = (id: string, label: string, position: number): ObjectiveGroup => ({
  id,
  label,
  position,
});

// Starter sub-groups for Sourcing (editable in the Field Builder).
const SOURCING_GROUPS: ObjectiveGroup[] = [
  g("g_linear", "Linear / Strips", 10),
  g("g_panels", "Panels & Troffers", 20),
  g("g_downlights", "Downlights", 30),
  g("g_drivers", "Drivers / PSU", 40),
  g("g_controls", "Controls", 50),
];

const f = (
  key: string,
  label: string,
  type: FieldDef["type"],
  position: number,
  extra: Partial<FieldDef> = {}
): FieldDef => ({ key, label, type, position, ...extra });

const s = (
  key: string,
  label: string,
  position: number,
  extra: Partial<StatusDef> = {}
): StatusDef => ({ key, label, position, ...extra });

const CURRENCY = ["USD", "RMB"];

// ── SOURCING ────────────────────────────────────────────────────────────────
// Objective-scope = the product TARGET (entered once). Quote-scope = repeats
// per supplier result; a product can hold several quotes (even same supplier).
const Q = "quote" as const;
const SOURCING_FIELDS: FieldDef[] = [
  // ── Target (objective-scope) ──
  f("product_category", "Categoría de producto", "text", 10, { group: "Target" }),
  f("target_price", "Target price (unitario)", "currency", 20, { group: "Target" }),
  f("target_specs", "Specs requeridas", "textarea", 30, { group: "Target", optional: true }),
  f("notes", "Notas", "textarea", 40, { group: "Target" }),

  // ── Por resultado / cotización (quote-scope) ──
  f("supplier", "Proveedor", "text", 100, { group: "Resultado", scope: Q }),
  f("mpn", "MPN / Modelo de fábrica", "text", 110, { group: "Resultado", scope: Q }),
  f("description", "Descripción", "textarea", 120, { group: "Resultado", scope: Q }),
  f("cost", "Cost (unitario)", "currency", 130, { group: "Resultado", scope: Q }),
  f("currency", "Moneda", "select", 140, { group: "Resultado", scope: Q, options: CURRENCY }),
  f("moq", "MOQ (mínimo)", "number", 150, { group: "Resultado", scope: Q, unit: "uds" }),
  f("payment_terms", "Términos de pago", "text", 160, { group: "Resultado", scope: Q, placeholder: "30% dep / 70% balance" }),
  f("incoterm", "Incoterm", "select", 170, { group: "Resultado", scope: Q, options: ["EXW", "FOB", "CIF", "DDP"] }),
  f("port", "Puerto", "text", 180, { group: "Resultado", scope: Q, placeholder: "Ningbo" }),
  f("lead_time_days", "Lead time", "number", 190, { group: "Resultado", scope: Q, unit: "días" }),
  f("sample_status", "Sample status", "select", 200, { group: "Resultado", scope: Q, options: ["Ninguna", "Pedida", "Recibida", "Aprobada", "Rechazada"] }),
  f("sample_cost", "Costo de muestra", "currency", 210, { group: "Resultado", scope: Q, optional: true }),
  f("monthly_capacity", "Capacidad mensual", "number", 220, { group: "Resultado", scope: Q, unit: "uds/mes", optional: true }),

  // Specs de iluminación por resultado (opcionales / addable)
  f("lumens", "Lumens", "number", 300, { group: "Specs", scope: Q, unit: "lm", optional: true }),
  f("lumens_per_ft", "Lumens / ft", "number", 310, { group: "Specs", scope: Q, unit: "lm/ft", optional: true }),
  f("watts", "Watts", "number", 320, { group: "Specs", scope: Q, unit: "W", optional: true }),
  f("input_voltage", "Input voltage", "text", 330, { group: "Specs", scope: Q, unit: "V", optional: true }),
  f("output_voltage", "Output voltage", "text", 340, { group: "Specs", scope: Q, unit: "V", optional: true }),
  f("cct", "CCT (color temp)", "text", 350, { group: "Specs", scope: Q, unit: "K", optional: true, placeholder: "3000K / 4000K" }),
  f("cri", "CRI", "number", 360, { group: "Specs", scope: Q, optional: true }),
  f("ip_rating", "IP rating", "text", 370, { group: "Specs", scope: Q, optional: true, placeholder: "IP65" }),
  f("beam_angle", "Beam angle", "number", 380, { group: "Specs", scope: Q, unit: "°", optional: true }),
  f("dimensions", "Dimensiones", "text", 390, { group: "Specs", scope: Q, optional: true }),
  f("certifications", "Certificaciones", "multiselect", 400, { group: "Specs", scope: Q, optional: true, options: ["UL", "ETL", "DLC", "CE", "RoHS", "FCC"] }),
  f("warranty", "Garantía", "text", 410, { group: "Specs", scope: Q, optional: true }),

  // Logística por resultado (opcional)
  f("units_per_carton", "Unidades por carton", "number", 500, { group: "Logística", scope: Q, optional: true }),
  f("cbm", "CBM", "number", 510, { group: "Logística", scope: Q, unit: "m³", optional: true }),
  f("carton_weight", "Peso carton", "number", 520, { group: "Logística", scope: Q, unit: "kg", optional: true }),
];

const SOURCING_STATUS: StatusDef[] = [
  s("identified", "Identificado", 10, { color: "slate" }),
  s("quoting", "Cotizando", 20, { color: "blue" }),
  s("sampling", "Muestra", 30, { color: "amber" }),
  s("negotiating", "Negociando", 40, { color: "violet" }),
  s("approved", "Aprobado", 50, { color: "emerald", terminal: true }),
  s("rejected", "Rechazado", 60, { color: "rose", terminal: true }),
];

// ── NEGOTIATION ──────────────────────────────────────────────────────────────
const NEGOTIATION_FIELDS: FieldDef[] = [
  f("counterparty", "Contraparte (fábrica)", "text", 10, { group: "General" }),
  f("speech", "Speech / Script", "textarea", 15, {
    group: "Speech / Script",
    placeholder:
      "Lo que le queremos decir: apertura, puntos clave, precio objetivo, concesiones, objeciones esperadas, cierre…",
  }),
  f("currency", "Moneda", "select", 20, { group: "Precio", options: CURRENCY }),
  f("current_price", "Precio actual", "currency", 30, { group: "Precio" }),
  f("asking_price", "Precio pedido", "currency", 40, { group: "Precio" }),
  f("target_price", "Target price", "currency", 50, { group: "Precio" }),
  f("agreed_price", "Precio acordado", "currency", 60, { group: "Precio" }),
  f("quantity", "Cantidad / volumen", "number", 70, { group: "Precio", unit: "uds" }),
  f("payment_terms", "Términos de pago", "text", 80, { group: "Términos", optional: true }),
  f("lead_time_days", "Lead time", "number", 90, { group: "Términos", unit: "días", optional: true }),
  f("concessions_asked", "Concesiones pedidas", "textarea", 100, { group: "Términos", optional: true }),
  f("concessions_offered", "Concesiones ofrecidas", "textarea", 110, { group: "Términos", optional: true }),
  f("deadline", "Deadline", "date", 120, { group: "General" }),
  f("batna", "Alternativa (BATNA)", "text", 130, { group: "General", optional: true }),
  f("notes", "Notas", "textarea", 140, { group: "General" }),
];

const NEGOTIATION_STATUS: StatusDef[] = [
  s("open", "Abierta", 10, { color: "blue" }),
  s("countered", "Contraoferta", 20, { color: "amber" }),
  s("agreed", "Acordada", 30, { color: "emerald", terminal: true }),
  s("walked_away", "Se cayó", 40, { color: "rose", terminal: true }),
];

// ── DECISIONS ────────────────────────────────────────────────────────────────
const DECISIONS_FIELDS: FieldDef[] = [
  f("context", "Contexto", "textarea", 10, { group: "General" }),
  f("options", "Opciones consideradas", "textarea", 20, { group: "General" }),
  f("decision_owner", "Quién decide", "text", 30, { group: "General" }),
  f("decide_by", "Decidir antes de", "date", 40, { group: "General" }),
  f("decision_made", "Decisión tomada", "textarea", 50, { group: "Resultado" }),
  f("rationale", "Justificación", "textarea", 60, { group: "Resultado", optional: true }),
  f("impact_value", "Impacto ($)", "currency", 70, { group: "Resultado", optional: true }),
  f("notes", "Notas", "textarea", 80, { group: "General" }),
];

const DECISIONS_STATUS: StatusDef[] = [
  s("pending", "Pendiente", 10, { color: "slate" }),
  s("deciding", "Decidiendo", 20, { color: "amber" }),
  s("decided", "Decidida", 30, { color: "emerald", terminal: true }),
  s("deferred", "Diferida", 40, { color: "zinc", terminal: true }),
];

export interface DefaultCategory {
  slug: string;
  label: string;
  icon_key: string;
  color_token: string;
  position: number;
  field_schema: FieldDef[];
  status_set: StatusDef[];
  default_status_key: string;
  groups: ObjectiveGroup[];
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { slug: "sourcing", label: "Sourcing", icon_key: "search", color_token: "blue", position: 10, field_schema: SOURCING_FIELDS, status_set: SOURCING_STATUS, default_status_key: "identified", groups: SOURCING_GROUPS },
  { slug: "negotiation", label: "Negotiation", icon_key: "handshake", color_token: "amber", position: 20, field_schema: NEGOTIATION_FIELDS, status_set: NEGOTIATION_STATUS, default_status_key: "open", groups: [] },
  { slug: "decisions", label: "Decisions", icon_key: "lock", color_token: "violet", position: 30, field_schema: DECISIONS_FIELDS, status_set: DECISIONS_STATUS, default_status_key: "pending", groups: [] },
];

export const DEFAULT_TRIP = {
  name: "China Trip",
  destination: "China",
  timezone: "Asia/Shanghai",
};
