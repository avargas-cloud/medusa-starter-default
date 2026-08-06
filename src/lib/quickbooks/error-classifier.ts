/**
 * Centralized QuickBooks error classifier.
 *
 * Single source of truth for "is this error transient / recoverable / permanent?".
 *
 * Why this exists:
 *   Each poller / consolidator pass previously had its own ad-hoc regex.
 *   - `customer-pass.ts`: no classification at all → every error → `failed` (incident PO #34, 2026-05-01).
 *   - `sync-customer-data-ext.ts`: only matches 3200 (`isAlreadyExistsError`).
 *   - `qb-purchase-order-poller.ts`: regex `3[12]00|po not found in qb|may have been deleted`
 *     conflates 3100 (not found) with 3200 (duplicate) and "EditSeq stale" with
 *     "PO genuinely deleted" (incident PO-1015/PO-1016, 2026-04-29 → 2026-05-01).
 *
 * This module replaces those by emitting a structured classification that
 * downstream callers branch on. It is **purely additive** in Phase 1 — no
 * existing behavior changes until callers are migrated to use it (Phases 2-3).
 *
 * Compatibility:
 *   - `isAlreadyExistsError` (sync-customer-data-ext.ts) ≡ class === "duplicate"
 *   - `isDoesNotExistError` (sync-customer-data-ext.ts) ≡ class === "not_found"
 *   - PO poller `isEditSeqErr` regex ≡ class in {"edit_seq","not_found","po_missing"}
 *     (the new classifier separates these so callers can act on the actual
 *     cause rather than free-retrying everything that matches one big regex).
 */

export type QbErrorClass =
  /** 3170 — entity locked or "modified by another user". Retry without state change. */
  | "lock"
  /** 3210 — stale EditSequence. Refresh and retry. */
  | "edit_seq"
  /** 3200 — entity already exists. Recoverable: try Mod instead of Add. */
  | "duplicate"
  /** 3100 / 3120 — entity not found. Recoverable: try Add instead of Mod. */
  | "not_found"
  /** Synthetic poller message after exhausting RefNumber recovery. Permanent. */
  | "po_missing"
  /** Synthetic — bridge response missing TxnID/expected fields. Re-query. */
  | "parser_failed"
  /** ECONNREFUSED, ETIMEDOUT, ENOTFOUND, fetch failed. Retry. */
  | "network"
  /** QBWC offline / queue full / bridge unreachable. Retry. */
  | "bridge_busy"
  /**
   * HRESULT de nivel QBWC (0x8004xxxx, salvo 0x80040400): la sesión murió sin
   * que QuickBooks devolviera una respuesta, así que **el resultado dentro de
   * QuickBooks es desconocido** — el documento pudo haberse commiteado igual.
   * Un ADD NUNCA se reintenta a ciegas ante esta clase: primero se verifica
   * existencia (ver `schedulePurchaseAddExistenceCheck`).
   */
  | "outcome_unknown"
  /** Default — anything else. No automatic retry. */
  | "permanent";

export interface QbErrorClassification {
  class: QbErrorClass;
  /** Caller should retry with the same payload after backoff. */
  isTransient: boolean;
  /** Caller has a known inverse-operation fallback (Add ⇄ Mod). */
  isRecoverable: boolean;
  /** QB error code if it could be parsed, otherwise null. */
  code: string | null;
  /** Original error message, never null (defaults to ""). */
  rawMessage: string;
}

// Patterns intentionally tight — broad regexes (like `3[12]00`) caused the
// PO-1015/PO-1016 zombie loop by lumping unrelated errors together.
// 3175 ("…already in use. The transaction could not be locked.") is a LOCK, not
// a duplicate — but its message contains "already in use", which RX_DUPLICATE
// also matches. LOCK is evaluated before DUPLICATE in classifyQbError, so adding
// 3175 / "could not be locked" here routes it to the transient lock class (retry
// with backoff) instead of being mis-classified as a terminal duplicate.
const RX_LOCK =
  /modified by another user|list has been modified|could not be locked|\b3170\b|\b3175\b/i;
const RX_EDIT_SEQ = /edit\s*sequence|editsequence|\b3210\b/i;
const RX_DUPLICATE = /already (exists|in use)|\b3200\b/i;
const RX_NOT_FOUND =
  /not found|no record (found)?|does not exist|\b3100\b|\b3120\b/i;
const RX_PO_MISSING = /po not found in qb|may have been deleted/i;
const RX_PARSER = /completed but no txnid|no txnid in response/i;
const RX_NETWORK =
  /econnrefused|etimedout|enotfound|fetch failed|socket hang up|network error|getaddrinfo/i;
const RX_BRIDGE_BUSY =
  /qbwc|queue is full|bridge busy|web connector|qb desktop may be offline|qbxml session|timeout waiting for bridge|bridge operation timed out/i;

// HRESULTs del QBSDK. Llegan por `receiveResponseXML` con el cuerpo de
// respuesta VACÍO: QBWC aborta la sesión y QuickBooks nunca contesta qué hizo.
// Por eso son su propia clase y no "permanent" — ver `outcome_unknown`.
//
// 0x80040400 es la excepción y va aparte: QuickBooks no pudo PARSEAR el XML,
// o sea que lo rechazó antes de mirar el archivo de la compañía. Ahí sí está
// probado que no se creó nada, y reintentar el mismo payload malformado sólo
// repite el error → permanente, como siempre fue.
const RX_HRESULT_XML_PARSE = /0x80040400/i;
const RX_HRESULT = /0x8004[0-9a-f]{4}/i;

function asString(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

export function classifyQbError(input: {
  message?: string | null;
  code?: string | number | null;
}): QbErrorClassification {
  const message = asString(input.message);
  const code = input.code != null ? String(input.code) : null;
  const haystack = `${code ?? ""} ${message}`.trim();

  // Synthetic markers first — they encode "we already tried recovery, give up".
  if (RX_PARSER.test(message)) {
    return {
      class: "parser_failed",
      isTransient: true,
      isRecoverable: false,
      code,
      rawMessage: message,
    };
  }
  if (RX_PO_MISSING.test(message)) {
    return {
      class: "po_missing",
      isTransient: false,
      isRecoverable: false,
      code,
      rawMessage: message,
    };
  }

  // HRESULT antes que cualquier regex de texto: el código describe el estado de
  // la SESIÓN (murió sin respuesta), y eso pesa más que lo que diga su mensaje
  // legible. Un texto que casualmente contenga "not found" no convierte un
  // aborto de sesión en un 3100.
  if (RX_HRESULT.test(haystack) && !RX_HRESULT_XML_PARSE.test(haystack)) {
    return {
      class: "outcome_unknown",
      // `isTransient` significa "reintentá el MISMO payload tras un backoff".
      // Para un resultado desconocido eso es exactamente lo que NO se puede
      // hacer: si el ADD entró, el reintento mintea un documento duplicado.
      // Queda en false para que `decideRetry` no habilite reintento genérico
      // en NINGÚN step; el único camino que reabre esta fila es el que primero
      // le pregunta a QuickBooks (`schedulePurchaseAddExistenceCheck`).
      isTransient: false,
      isRecoverable: false,
      code,
      rawMessage: message,
    };
  }

  // QB error codes — exact matches first (most specific).
  if (code === "3170" || RX_LOCK.test(haystack)) {
    return {
      class: "lock",
      isTransient: true,
      isRecoverable: false,
      code,
      rawMessage: message,
    };
  }
  if (code === "3210" || RX_EDIT_SEQ.test(haystack)) {
    return {
      class: "edit_seq",
      isTransient: true,
      isRecoverable: false,
      code,
      rawMessage: message,
    };
  }
  if (code === "3200" || RX_DUPLICATE.test(haystack)) {
    return {
      class: "duplicate",
      isTransient: true,
      isRecoverable: true,
      code,
      rawMessage: message,
    };
  }
  if (code === "3100" || code === "3120" || RX_NOT_FOUND.test(haystack)) {
    return {
      class: "not_found",
      isTransient: true,
      isRecoverable: true,
      code,
      rawMessage: message,
    };
  }

  // Infrastructure errors.
  if (RX_NETWORK.test(haystack)) {
    return {
      class: "network",
      isTransient: true,
      isRecoverable: false,
      code,
      rawMessage: message,
    };
  }
  if (RX_BRIDGE_BUSY.test(haystack)) {
    return {
      class: "bridge_busy",
      isTransient: true,
      isRecoverable: false,
      code,
      rawMessage: message,
    };
  }

  return {
    class: "permanent",
    isTransient: false,
    isRecoverable: false,
    code,
    rawMessage: message,
  };
}
