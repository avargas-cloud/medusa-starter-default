/**
 * GET / POST /admin/pos/rounding-accounts
 *
 * Las tres cuentas de QuickBooks del write-off de redondeo, en `store.metadata`.
 *
 * Existen como endpoint —y no sólo como filas que se editan por SQL— porque el
 * argumento entero para sacarlas de env fue que tienen que ser **visibles y
 * cambiables sin un deploy**. Una config que sólo se toca con `psql` es tan
 * invisible como una env var, con pasos extra.
 *
 * A diferencia del PIN de supervisor, estos valores **no son secretos**: son
 * `ListID` de un plan de cuentas. Se devuelven completos a propósito — el
 * operador tiene que poder comparar contra lo que ve en QuickBooks.
 *
 * Faltando CUALQUIERA de las tres, el mecanismo queda apagado (`lib/rounding/config.ts`).
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import {
  ROUNDING_CONFIG_KEYS,
  invalidateRoundingConfigCache,
  loadRoundingConfig,
} from "../../../../lib/rounding/config";

const FIELDS = [
  { key: ROUNDING_CONFIG_KEYS.shortage, label: "Shortages (absorbemos)" },
  { key: ROUNDING_CONFIG_KEYS.overage, label: "Overages (sobró plata)" },
  { key: ROUNDING_CONFIG_KEYS.ar, label: "Accounts Receivable" },
] as const;

/** Un ListID de QuickBooks: `8 hex - epoch`. Validar acá evita descubrir un
 *  typo recién cuando QuickBooks rechaza un asiento contable. */
const LIST_ID_RE = /^[0-9A-Fa-f]{8}-\d+$/;

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "store",
    fields: ["id", "metadata"],
  });
  const metadata = (data?.[0]?.metadata ?? {}) as Record<string, unknown>;
  const config = await loadRoundingConfig();

  return res.json({
    accounts: Object.fromEntries(
      FIELDS.map((f) => [f.key, (metadata[f.key] as string) ?? null])
    ),
    /** `true` sólo con las TRES puestas — es el kill switch, no un flag aparte. */
    enabled: config !== null,
    fields: FIELDS,
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);

  const patch: Record<string, string | null> = {};
  for (const f of FIELDS) {
    if (!(f.key in body)) continue;
    const raw = body[f.key];
    // `null` o "" apagan esa cuenta — y con eso el mecanismo entero. Es
    // deliberado: es la forma de apagarlo sin tocar código ni deploy.
    if (raw === null || raw === "") {
      patch[f.key] = null;
      continue;
    }
    const v = String(raw).trim();
    if (!LIST_ID_RE.test(v)) {
      return res.status(400).json({
        error: `"${f.label}" no parece un ListID de QuickBooks (formato 8 hex-epoch): ${v}`,
      });
    }
    patch[f.key] = v;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "No se mandó ninguna cuenta a cambiar." });
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({ entity: "store", fields: ["id", "metadata"] });
  const storeId = data?.[0]?.id;
  if (!storeId) return res.status(404).json({ error: "Store not found" });
  const currentMetadata = (data[0]?.metadata ?? {}) as Record<string, unknown>;

  // Auditoría: quién y cuándo. Es la mitad del motivo por el que esto salió de
  // env — una env var no deja rastro de quién la cambió.
  const actor =
    (req as any).auth_context?.actor_id ?? (req as any).user?.email ?? "unknown";

  const storeService: any = req.scope.resolve("store");
  // READ-MODIFY-WRITE obligatorio: `updateStores` REEMPLAZA el metadata entero,
  // no lo mergea. Medido acá mismo — un POST que cambiaba UNA cuenta borró las
  // otras dos y apagó el mecanismo en silencio. Es la regla del repo ("todo
  // write parcial de metadata hidrata y mergea"), que este endpoint violó en su
  // primera versión y sólo se vio al probarlo de verdad.
  await storeService.updateStores(storeId, {
    metadata: {
      ...currentMetadata,
      ...patch,
      qb_rounding_accounts_audit: {
        changed_by: actor,
        changed_at: new Date().toISOString(),
        keys: Object.keys(patch),
      },
    },
  });

  // El cache tiene TTL de 60s; sin esto el proceso que atendió el POST seguiría
  // usando el valor viejo hasta un minuto después de haberlo cambiado.
  invalidateRoundingConfigCache();

  const config = await loadRoundingConfig();
  logger.info(
    `[rounding-accounts] ${actor} cambió ${Object.keys(patch).join(", ")} — mecanismo ${config ? "PRENDIDO" : "APAGADO"}`
  );

  return res.json({ ok: true, enabled: config !== null });
}
