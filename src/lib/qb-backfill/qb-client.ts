/**
 * src/lib/qb-backfill/qb-client.ts
 *
 * Cliente QBXML genérico de sólo lectura para el backfill de compras: submit
 * por `/api/sync/direct-query`, poll por `/api/sync/status/:op`, parse laxo, y
 * caché en disco por ventana (un archivo cacheado NUNCA se re-consulta —
 * mismo contrato que `report-client.ts`).
 *
 * SÓLO `*QueryRq`. Este módulo no tiene ninguna función Add/Mod/Void.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeFetch, pollBridgeStatus } from "../quickbooks/bridge-fetch";

export class QbBackfillClientError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "QbBackfillClientError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DirectQueryOptions {
  cacheDir: string;
  cacheKey: string;
  /** default 6 s × 80 = 8 min — el bridge procesa en serie. */
  pollIntervalMs?: number;
  maxPolls?: number;
  log?: (line: string) => void;
}

export function cachePathFor(cacheDir: string, cacheKey: string): string {
  return join(cacheDir, `${cacheKey}.json`);
}

/**
 * Extrae el `<Tipo>QueryRs` de la respuesta del bridge. `rsKey` = p.ej.
 * "PurchaseOrderQueryRs". Lanza si `statusCode` no es "0" (rechazo de QB) o
 * "1" (sin resultados — el caller trata esto como lista vacía, NO como
 * error: ver `directQuery`).
 */
function extractRs(
  data: Record<string, unknown>,
  rsKey: string
): { $?: { statusCode?: string; statusMessage?: string }; [k: string]: unknown } {
  const op = data.operation as
    | { result?: { QBXML?: { QBXMLMsgsRs?: Record<string, unknown> } }; error?: unknown }
    | undefined;
  const rs = op?.result?.QBXML?.QBXMLMsgsRs?.[rsKey] as
    | { $?: { statusCode?: string; statusMessage?: string } }
    | undefined;
  if (!rs) {
    throw new QbBackfillClientError(`la respuesta no trae ${rsKey}`, op?.error ?? data);
  }
  return rs as { $?: { statusCode?: string; statusMessage?: string }; [k: string]: unknown };
}

/**
 * Somete un QBXML `*QueryRq`, esperando el `*QueryRs` correspondiente. Usa
 * caché en disco por `cacheKey`: si el archivo existe, se devuelve sin
 * tocar el bridge.
 *
 * `statusCode "1"` (sin resultados) devuelve `{ rs: null }` — es un caso OK,
 * no un error. Cualquier otro `statusCode` distinto de "0" lanza.
 */
async function directQueryOnce(
  qbxml: string,
  rsKey: string,
  opts: DirectQueryOptions
): Promise<{ rs: Record<string, unknown> | null; cached: boolean }> {
  const path = cachePathFor(opts.cacheDir, opts.cacheKey);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    return { rs: raw, cached: true };
  }
  const log = opts.log ?? (() => undefined);
  const submitted = await bridgeFetch<{ operationId?: string; operation_id?: string }>(
    "/api/sync/direct-query",
    { method: "POST", body: { qbxml }, timeoutMs: 30_000 }
  );
  const opId = submitted?.operationId ?? submitted?.operation_id;
  if (!opId) throw new QbBackfillClientError("el bridge no devolvió operationId", submitted);
  log(`  bridge op ${opId} (${opts.cacheKey})`);

  const interval = opts.pollIntervalMs ?? 6_000;
  const maxPolls = opts.maxPolls ?? 80;
  for (let i = 1; i <= maxPolls; i++) {
    await sleep(interval);
    const status = await pollBridgeStatus(opId);
    if (status.status === "expired") {
      throw new QbBackfillClientError(`operación ${opId} expiró en el bridge`);
    }
    if (status.status === "completed") {
      const rs = extractRs(status.data, rsKey);
      const statusCode = rs.$?.statusCode;
      let result: Record<string, unknown> | null;
      if (statusCode === "0") {
        result = rs;
      } else if (statusCode === "1") {
        result = null; // sin resultados — no es error
      } else {
        throw new QbBackfillClientError(
          `QB rechazó ${rsKey}: statusCode=${statusCode} ${rs.$?.statusMessage ?? ""}`,
          rs.$
        );
      }
      mkdirSync(opts.cacheDir, { recursive: true });
      writeFileSync(path, JSON.stringify(result));
      return { rs: result, cached: false };
    }
    if (status.status === "failed") {
      const op = status.data.operation as { error?: unknown } | undefined;
      // Un `failed` temprano con error vacío es un poll prematuro.
      if (op?.error) {
        throw new QbBackfillClientError(`operación ${opId} falló`, op.error);
      }
    }
    if (i % 10 === 0) log(`  poll ${i}: ${status.status}`);
  }
  throw new QbBackfillClientError(`operación ${opId} sin completar tras ${maxPolls} polls`);
}

/** Normaliza dict→array: un solo resultado llega como objeto, varios como lista. */
export function asList<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Errores de red transitorios (bridge detrás de Cloudflare): se reintenta; un rechazo de QB no. */
function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof QbBackfillClientError) return false;
  const text = `${(err as Error)?.message ?? ""} ${String((err as { cause?: unknown })?.cause ?? "")}`;
  return /fetch failed|ConnectTimeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|UND_ERR|aborted/i.test(text);
}

/**
 * `directQuery` con reintento: la descarga histórica son ~126 consultas de
 * 1–3 min cada una y el 2026-09-11 UN `ConnectTimeoutError` en un poll mató
 * el proceso entero (sin reintento en `bridge-fetch`, que es infra compartida
 * y no se toca acá). Reintentar una consulta de LECTURA es gratis: si la
 * operación anterior siguió viva en el bridge, la nueva simplemente vuelve a
 * preguntar. Hasta 6 intentos, backoff 10 s → 60 s.
 */
export async function directQuery(
  qbxml: string,
  rsKey: string,
  opts: DirectQueryOptions & { attempts?: number }
): Promise<{ rs: Record<string, unknown> | null; cached: boolean }> {
  const attempts = opts.attempts ?? 6;
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await directQueryOnce(qbxml, rsKey, opts);
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || i === attempts) throw err;
      const wait = Math.min(60_000, 10_000 * i);
      (opts.log ?? (() => undefined))(`  red: ${(err as Error).message.slice(0, 80)} — reintento ${i}/${attempts - 1} en ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastError;
}
