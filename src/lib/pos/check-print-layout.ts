/**
 * src/lib/pos/check-print-layout.ts
 *
 * Layout del cheque REAL sobre el papel pre-impreso (Office Depot B7200 /
 * voucher QuickBooks): dónde cae cada campo cuando se imprime encima de la
 * hoja carta ya troquelada. Coordenadas en PULGADAS desde la esquina superior
 * izquierda de la hoja (8.5 × 11); `y` es el TOPE de la caja de texto de cada
 * campo, no la línea base. Se persiste entero en `store.metadata.check_print_layout`
 * (jsonb) — ver `src/api/admin/settings/check-print-layout/route.ts`.
 */

import { z } from "zod";

export type CheckPrintStubs = "both" | "first" | "none";
export type CheckPrintAlign = "left" | "right";

export interface CheckPrintField {
  x: number;
  y: number;
  w: number;
  align?: CheckPrintAlign;
}

export type CheckPrintFieldKey =
  | "date"
  | "payee"
  | "amount"
  | "amount_words"
  | "memo"
  | "stub1"
  | "stub2";

export interface CheckPrintLayout {
  version: 1;
  preset: "b7200";
  offset_x: number;
  offset_y: number;
  font_pt: number;
  stubs: CheckPrintStubs;
  fields: Record<CheckPrintFieldKey, CheckPrintField>;
}

export const CHECK_PRINT_LAYOUT_KEY = "check_print_layout";

const CHECK_PRINT_FIELD_KEYS: CheckPrintFieldKey[] = [
  "date",
  "payee",
  "amount",
  "amount_words",
  "memo",
  "stub1",
  "stub2",
];

const checkPrintFieldSchema = z
  .object({
    x: z.number().min(0).max(8.5),
    y: z.number().min(0).max(11),
    w: z.number().min(0.5).max(8.5),
    align: z.enum(["left", "right"]).optional(),
  })
  .strict();

export const checkPrintLayoutSchema = z
  .object({
    version: z.literal(1),
    preset: z.literal("b7200"),
    offset_x: z.number().min(-1).max(1),
    offset_y: z.number().min(-1).max(1),
    font_pt: z.number().min(8).max(14),
    stubs: z.enum(["both", "first", "none"]),
    fields: z
      .object({
        date: checkPrintFieldSchema,
        payee: checkPrintFieldSchema,
        amount: checkPrintFieldSchema,
        amount_words: checkPrintFieldSchema,
        memo: checkPrintFieldSchema,
        stub1: checkPrintFieldSchema,
        stub2: checkPrintFieldSchema,
      })
      .strict(),
  })
  .strict();

/** Preset B7200 (Regions), recalibrado el 09/18/2026 contra un cheque IMPRESO: la primera medición
 * (foto con perspectiva) quedó 0.1–0.2" alta en la cara y ponía la fecha sobre la etiqueta "Date". */
export const DEFAULT_CHECK_PRINT_LAYOUT: CheckPrintLayout = Object.freeze({
  version: 1,
  preset: "b7200",
  offset_x: 0,
  offset_y: 0,
  font_pt: 11,
  stubs: "both",
  fields: Object.freeze({
    date: { x: 6.95, y: 0.78, w: 1.1 },
    payee: { x: 1.05, y: 1.34, w: 5.5 },
    amount: { x: 6.9, y: 1.34, w: 1.4, align: "right" },
    amount_words: { x: 0.35, y: 1.59, w: 6.8 },
    memo: { x: 0.85, y: 2.6, w: 3.0 },
    stub1: { x: 0.5, y: 3.75, w: 7.5 },
    stub2: { x: 0.5, y: 7.25, w: 7.5 },
  }),
}) as CheckPrintLayout;

// sanity check interno: las 7 claves declaradas arriba deben cubrir el tipo.
void (CHECK_PRINT_FIELD_KEYS satisfies CheckPrintFieldKey[]);

/**
 * Lectura fail-open a defaults: `raw` ausente o que no pase el schema nunca
 * bloquea la impresión — vuelve el layout de fábrica con `is_default: true`.
 */
export function parseStoredCheckPrintLayout(raw: unknown): {
  layout: CheckPrintLayout;
  is_default: boolean;
} {
  if (raw === null || raw === undefined) {
    return { layout: DEFAULT_CHECK_PRINT_LAYOUT, is_default: true };
  }
  const parsed = checkPrintLayoutSchema.safeParse(raw);
  if (!parsed.success) {
    return { layout: DEFAULT_CHECK_PRINT_LAYOUT, is_default: true };
  }
  return { layout: parsed.data, is_default: false };
}
