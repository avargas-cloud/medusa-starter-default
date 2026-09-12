/**
 * qb-gl-import — cliente del reporte General Ledger vía el bridge de QuickBooks.
 *
 * SÓLO LECTURA: `GeneralDetailReportQueryRq` no puede crear ni modificar nada
 * en QB. Va por el passthrough crudo (`/api/sync/direct-query`, envelope
 * completo — sin envelope el bridge devuelve 0x80040400) y se pollea
 * `/api/sync/status/:op` igual que el resto del pipeline.
 *
 * Caché en disco por ventana: una semana pesa ~1,5 MB y tarda 2-3 min de COM;
 * re-parsear no vuelve a consultar el bridge (misma disciplina que
 * `scripts/qb-recon/reparse.py`). Un archivo cacheado NUNCA se sobreescribe
 * en silencio: borrarlo es la forma de forzar una re-descarga.
 *
 * Sondeado el 2026-09-11 (qb-query skill): positivo = 1342 filas / 151 docs en
 * una semana; control negativo (request inventado) = 0x80040400. Ventanas
 * autocontenidas — los iterators QBXML no sobreviven entre operaciones.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeFetch, pollBridgeStatus } from "../../quickbooks/bridge-fetch";
import type { RawReportRet } from "./parse-report";

export const GL_REPORT_COLUMNS = [
  "TxnID",
  "TxnType",
  "Date",
  "RefNumber",
  "Name",
  "Memo",
  "Account",
  "SplitAccount",
  "ClearedStatus",
  "Debit",
  "Credit",
  "Amount",
] as const;

export function buildGeneralLedgerQbxml(from: string, to: string): string {
  for (const d of [from, to])
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`fecha inválida: ${d}`);
  const columns = GL_REPORT_COLUMNS.map((c) => `<IncludeColumn>${c}</IncludeColumn>`).join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?>` +
    `<QBXML><QBXMLMsgsRq onError="stopOnError">` +
    `<GeneralDetailReportQueryRq requestID="1">` +
    `<GeneralDetailReportType>GeneralLedger</GeneralDetailReportType>` +
    `<ReportPeriod><FromReportDate>${from}</FromReportDate><ToReportDate>${to}</ToReportDate></ReportPeriod>` +
    columns +
    `</GeneralDetailReportQueryRq></QBXMLMsgsRq></QBXML>`
  );
}

/** Ventanas [from,to] inclusivas de `days` días que cubren el rango. */
export function* reportWindows(from: string, to: string, days: number): Generator<{ from: string; to: string }> {
  if (days < 1) throw new Error("days debe ser ≥ 1");
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  let start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end)
    throw new Error(`rango inválido: ${from}..${to}`);
  while (start <= end) {
    const stop = new Date(start);
    stop.setUTCDate(stop.getUTCDate() + days - 1);
    const winEnd = stop > end ? end : stop;
    yield { from: toIso(start), to: toIso(winEnd) };
    start = new Date(winEnd);
    start.setUTCDate(start.getUTCDate() + 1);
  }
}

export class QbGlBridgeError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "QbGlBridgeError";
  }
}

type ReportRs = {
  $?: { statusCode?: string; statusSeverity?: string; statusMessage?: string };
  ReportRet?: RawReportRet;
};

function extractReport(data: Record<string, unknown>): RawReportRet {
  const op = data.operation as { result?: { QBXML?: { QBXMLMsgsRs?: Record<string, unknown> } }; error?: unknown } | undefined;
  const rs = op?.result?.QBXML?.QBXMLMsgsRs?.GeneralDetailReportQueryRs as ReportRs | undefined;
  if (!rs) throw new QbGlBridgeError("la respuesta no trae GeneralDetailReportQueryRs", op?.error ?? data);
  if (rs.$?.statusCode !== "0")
    throw new QbGlBridgeError(`QB rechazó el reporte: ${rs.$?.statusCode} ${rs.$?.statusMessage ?? ""}`, rs.$);
  if (!rs.ReportRet) throw new QbGlBridgeError("ReportRet ausente", rs);
  return rs.ReportRet;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchWindowOptions {
  cacheDir: string;
  /** default 6 s × 80 = 8 min: el bridge procesa en serie y una semana tarda 2-3 min. */
  pollIntervalMs?: number;
  maxPolls?: number;
  log?: (line: string) => void;
}

export function cachePathFor(cacheDir: string, from: string, to: string): string {
  return join(cacheDir, `gl_${from}_${to}.json`);
}

/** Devuelve el `ReportRet` crudo de la ventana, desde caché si existe. */
export async function fetchGeneralLedgerWindow(
  from: string,
  to: string,
  opts: FetchWindowOptions
): Promise<{ report: RawReportRet; cached: boolean }> {
  const path = cachePathFor(opts.cacheDir, from, to);
  if (existsSync(path)) {
    return { report: JSON.parse(readFileSync(path, "utf8")) as RawReportRet, cached: true };
  }
  const log = opts.log ?? (() => undefined);
  const submitted = await bridgeFetch<{ operationId?: string; operation_id?: string }>(
    "/api/sync/direct-query",
    { method: "POST", body: { qbxml: buildGeneralLedgerQbxml(from, to) }, timeoutMs: 30_000 }
  );
  const opId = submitted?.operationId ?? submitted?.operation_id;
  if (!opId) throw new QbGlBridgeError("el bridge no devolvió operationId", submitted);
  log(`  bridge op ${opId} (${from}..${to})`);

  const interval = opts.pollIntervalMs ?? 6_000;
  const maxPolls = opts.maxPolls ?? 80;
  for (let i = 1; i <= maxPolls; i++) {
    await sleep(interval);
    const status = await pollBridgeStatus(opId);
    if (status.status === "expired") throw new QbGlBridgeError(`operación ${opId} expiró en el bridge`);
    if (status.status === "completed") {
      const report = extractReport(status.data);
      mkdirSync(opts.cacheDir, { recursive: true });
      writeFileSync(path, JSON.stringify(report));
      return { report, cached: false };
    }
    if (status.status === "failed") {
      const op = status.data.operation as { error?: unknown } | undefined;
      // Un `failed` temprano con error vacío es un poll prematuro (skill qb-query, gotcha 4).
      if (op?.error) throw new QbGlBridgeError(`operación ${opId} falló`, op.error);
    }
    if (i % 10 === 0) log(`  poll ${i}: ${status.status}`);
  }
  throw new QbGlBridgeError(`operación ${opId} sin completar tras ${maxPolls} polls`);
}
