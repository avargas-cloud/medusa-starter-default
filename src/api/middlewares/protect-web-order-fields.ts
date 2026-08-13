import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { assertWebOrderAuthorized } from "../admin/orders/[id]/_lib/assert-web-order-authorized";

/**
 * Gatea los campos de CONTRATO de una orden WEB en la ruta NATIVA de Medusa.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * Una orden web es un contrato que el cliente armó solo. Las 8 rutas custom de
 * edición ya exigen PIN de supervisor (`assertWebOrderAuthorized`), pero
 * `POST /admin/orders/:id` — la ruta que trae el framework — acepta cualquier
 * metadata sin saber nada de ese contrato: por ahí se podía reescribir el
 * descuento, los totales declarados o las direcciones de una orden web sin
 * ningún guard. Mismo agujero que el PIN por `/admin/stores/:id`.
 *
 * ── Qué hace ──────────────────────────────────────────────────────────────────
 * Si el body toca un campo de contrato (descuento, totales POS, direcciones,
 * email), la orden se resuelve por origen: web → exige PIN (mismo guard con
 * throttle que las rutas custom); POS → pasa. La metadata OPERATIVA
 * (pos_last_edited_by, order_status de emails, sales_rep, notas…) pasa libre
 * en ambos orígenes — flujos como send-email escriben por acá sin PIN.
 *
 * La PRESENCIA de la clave cuenta, no su truthiness: mandar
 * `discount_value: null` es quitar el descuento, igual de contractual.
 */
const PROTECTED_METADATA_KEYS = [
  "discount_type",
  "discount_value",
  "promotion_code",
  "pos_discount_amount",
  "pos_total",
  "computed_total",
  "pos_tax_amount",
  "pos_tax_rate",
] as const;

const PROTECTED_TOP_LEVEL_KEYS = [
  "shipping_address",
  "billing_address",
  "email",
] as const;

export async function protectWebOrderFields(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : {};

  const touchesProtected =
    PROTECTED_TOP_LEVEL_KEYS.some((k) => k in body) ||
    PROTECTED_METADATA_KEYS.some((k) => k in metadata);
  if (!touchesProtected) {
    return next();
  }

  const orderId = String((req.params as Record<string, string>)?.id ?? "");
  if (!orderId) {
    // El matcher garantiza :id; sin él, que la ruta conteste su propio 404.
    return next();
  }

  const { denial } = await assertWebOrderAuthorized(req.scope, orderId, req);
  if (!denial) {
    return next();
  }
  res.status(denial.status).json(denial.body);
}
