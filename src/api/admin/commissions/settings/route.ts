/**
 * GET / POST /admin/commissions/settings
 *
 * Configuración de Order Commissions en `store.metadata` (misma capa y mismas
 * razones que rounding-accounts: visible, cambiable sin deploy, con auditoría).
 *
 * Dos clases de valores (ver lib/commissions/config.ts):
 *  · cap_bps / wait_days — parámetros de negocio con default de diseño.
 *  · las 4 claves de cuentas QB — sin default; faltando cualquiera, la
 *    LIQUIDACIÓN queda apagada (la asignación sigue funcionando).
 */
import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import {
  COMMISSION_CONFIG_KEYS,
  DEFAULT_CAP_BPS,
  DEFAULT_WAIT_DAYS,
  invalidateCommissionConfigCache,
  loadCommissionBusinessConfig,
  loadCommissionQbAccounts,
} from "../../../../lib/commissions/config";
import { assertAccounting } from "../_lib/guard";

const LIST_ID_RE = /^[0-9A-Fa-f]{8}-\d+$/;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({ entity: "store", fields: ["id", "metadata"] });
  const metadata = (data?.[0]?.metadata ?? {}) as Record<string, unknown>;
  const business = await loadCommissionBusinessConfig();
  const accounts = await loadCommissionQbAccounts();

  res.json({
    cap_bps: business.capBps,
    wait_days: business.waitDays,
    defaults: { cap_bps: DEFAULT_CAP_BPS, wait_days: DEFAULT_WAIT_DAYS },
    accounts: {
      [COMMISSION_CONFIG_KEYS.expenseAccountListId]:
        (metadata[COMMISSION_CONFIG_KEYS.expenseAccountListId] as string) ?? null,
      [COMMISSION_CONFIG_KEYS.expenseAccountFullName]:
        (metadata[COMMISSION_CONFIG_KEYS.expenseAccountFullName] as string) ?? null,
      [COMMISSION_CONFIG_KEYS.clearingAccountListId]:
        (metadata[COMMISSION_CONFIG_KEYS.clearingAccountListId] as string) ?? null,
      [COMMISSION_CONFIG_KEYS.clearingAccountFullName]:
        (metadata[COMMISSION_CONFIG_KEYS.clearingAccountFullName] as string) ?? null,
    },
    /** true sólo con las 4 cuentas puestas — el kill switch de la liquidación. */
    settlement_enabled: accounts !== null,
  });
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!(await assertAccounting(req, res))) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const patch: Record<string, string | null> = {};

  if ("cap_bps" in body) {
    const v = Number(body.cap_bps);
    if (!Number.isInteger(v) || v <= 0 || v > 10_000) {
      res.status(400).json({ error: "cap_bps must be an integer in (0, 10000]." });
      return;
    }
    patch[COMMISSION_CONFIG_KEYS.capBps] = String(v);
  }
  if ("wait_days" in body) {
    const v = Number(body.wait_days);
    if (!Number.isInteger(v) || v <= 0 || v > 365) {
      res.status(400).json({ error: "wait_days must be an integer in (0, 365]." });
      return;
    }
    patch[COMMISSION_CONFIG_KEYS.waitDays] = String(v);
  }

  const accountFields: Array<{ key: string; isListId: boolean; label: string }> = [
    { key: COMMISSION_CONFIG_KEYS.expenseAccountListId, isListId: true, label: "Expense ListID" },
    { key: COMMISSION_CONFIG_KEYS.expenseAccountFullName, isListId: false, label: "Expense name" },
    { key: COMMISSION_CONFIG_KEYS.clearingAccountListId, isListId: true, label: "Clearing ListID" },
    { key: COMMISSION_CONFIG_KEYS.clearingAccountFullName, isListId: false, label: "Clearing name" },
  ];
  for (const f of accountFields) {
    if (!(f.key in body)) continue;
    const raw = body[f.key];
    // null/"" apagan esa clave — y con eso la liquidación entera. Deliberado.
    if (raw === null || raw === "") {
      patch[f.key] = null;
      continue;
    }
    const v = String(raw).trim();
    if (f.isListId && !LIST_ID_RE.test(v)) {
      res.status(400).json({
        error: `"${f.label}" does not look like a QuickBooks ListID (8 hex-epoch): ${v}`,
      });
      return;
    }
    patch[f.key] = v;
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No values were sent to change." });
    return;
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({ entity: "store", fields: ["id", "metadata"] });
  const storeId = data?.[0]?.id;
  if (!storeId) {
    res.status(404).json({ error: "Store not found" });
    return;
  }
  const currentMetadata = (data[0]?.metadata ?? {}) as Record<string, unknown>;
  const actor = req.auth_context?.actor_id ?? "unknown";

  interface StoreServiceLike {
    updateStores: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  }
  const storeService = req.scope.resolve("store") as StoreServiceLike;
  // READ-MODIFY-WRITE obligatorio: updateStores REEMPLAZA el metadata entero
  // (regla del repo, medida en rounding-accounts — un write parcial borraba las
  // otras claves y apagaba el mecanismo en silencio).
  await storeService.updateStores(storeId, {
    metadata: {
      ...currentMetadata,
      ...patch,
      commission_settings_audit: {
        changed_by: actor,
        changed_at: new Date().toISOString(),
        keys: Object.keys(patch),
      },
    },
  });

  invalidateCommissionConfigCache();
  const accounts = await loadCommissionQbAccounts();
  logger.info(
    `[commissions-settings] ${actor} cambió ${Object.keys(patch).join(", ")} — liquidación ${accounts ? "PRENDIDA" : "APAGADA"}`
  );
  res.json({ ok: true, settlement_enabled: accounts !== null });
}
