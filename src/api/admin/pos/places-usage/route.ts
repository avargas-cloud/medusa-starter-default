import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { PLACES_USAGE_MODULE } from "../../../../modules/places-usage";
import type PlacesUsageModuleService from "../../../../modules/places-usage/service";
import type {
  PlacesUsageKind,
  PlacesUsageSource,
} from "../../../../modules/places-usage/service";

/**
 * Usage counters for the Google Places address lookup.
 *
 *   GET  /admin/pos/places-usage  → today + month-to-date, per source
 *   POST /admin/pos/places-usage  → { source, kind, error_code? }  (increment)
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * El autocompletado de direcciones es la única dependencia externa FACTURADA que
 * el POS golpea por tecla. Su consumo, y sobre todo el momento en que Google
 * rechaza una llamada por cuota agotada, vivían solamente en los logs de Vercel
 * — donde nadie mira. Con un techo diario de 320 llamadas, enterarse de que se
 * tocó importa.
 *
 * ── Lo que este endpoint NO es ────────────────────────────────────────────────
 * No es la verdad de facturación. Los contadores se escriben fire-and-forget
 * desde rutas serverless (para que un backend lento jamás demore a un cajero
 * tipeando una dirección), así que algunas escrituras se pierden. La consola de
 * Google Cloud sigue siendo la fuente autoritativa; esto es un indicador
 * operativo, y la UI lo dice con todas las letras.
 */

/**
 * El techo diario configurado en Google Cloud. Se lee del entorno para que la
 * pantalla no mienta si se cambia allá: un número hardcodeado acá y otro en la
 * consola es peor que no mostrar ninguno.
 */
const DAILY_QUOTA = Number(process.env.PLACES_DAILY_QUOTA ?? 320);

/** Franquicia mensual gratis por SKU (Google retiró el crédito de $200 en marzo 2025). */
const MONTHLY_FREE_TIER = Number(process.env.PLACES_MONTHLY_FREE_TIER ?? 10_000);

const VALID_SOURCES: PlacesUsageSource[] = ["pos", "web"];
const VALID_KINDS: PlacesUsageKind[] = [
  "lookup",
  "details",
  "quota_error",
  "other_error",
];

function service(req: MedusaRequest): PlacesUsageModuleService {
  return (
    req.scope as unknown as { resolve: (k: string) => unknown }
  ).resolve(PLACES_USAGE_MODULE) as PlacesUsageModuleService;
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const summary = await service(req).summary(DAILY_QUOTA, MONTHLY_FREE_TIER);
  res.json(summary);
}

interface RecordBody {
  source?: string;
  kind?: string;
  error_code?: string;
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const body = (req.body ?? {}) as RecordBody;

  const source = body.source as PlacesUsageSource;
  const kind = body.kind as PlacesUsageKind;

  if (!VALID_SOURCES.includes(source) || !VALID_KINDS.includes(kind)) {
    res.status(400).json({
      error: "invalid_payload",
      message: `source must be one of ${VALID_SOURCES.join("|")} and kind one of ${VALID_KINDS.join("|")}`,
    });
    return;
  }

  // `error_code` es una etiqueta para mostrar, no texto libre del usuario: se
  // recorta para que un upstream verborrágico no llene la columna.
  const errorCode = body.error_code ? String(body.error_code).slice(0, 64) : undefined;

  try {
    await service(req).record(source, kind, errorCode);
    res.json({ recorded: true });
  } catch (err) {
    // Contar no puede ser la razón por la que algo falla. El caller es
    // fire-and-forget y ya ignora la respuesta; se loguea y se contesta 200
    // para que ningún reintento se dispare por esto.
    req.scope.resolve("logger").error(`[places-usage] record failed: ${err}`);
    res.json({ recorded: false });
  }
}
