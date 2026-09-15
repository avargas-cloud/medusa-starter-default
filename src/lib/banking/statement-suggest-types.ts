import type { StatementBookItem, StatementLine } from "./statement-types";

/**
 * Sugerencias de casamiento línea-del-banco ↔ asiento(s) del libro. Es la salida PURA del
 * casador (las etapas 5a–5e que vivían en `reconcile-feed-statement.ts`): un plan que dice
 * qué casaría y por qué, sin escribir nada. Quien lo aplica decide: el script lo casa entero
 * (puesta al día), el feed lo muestra y el contador confirma línea por línea (2026-09-15).
 */
export type SuggestStage =
  | "check_number" // 5a
  | "exact_amount" // 5b
  | "bank_sum" // 5c — varias líneas del banco = un asiento
  | "book_net" // 5d — una línea del banco = suma neta de varios asientos
  | "split"; // 5e — k líneas ↔ m asientos, misma suma, distinto reparto

/** Un asiento propuesto para una línea, con el monto que se le asigna (siempre positivo). */
export type SuggestCandidate = {
  book_id: string;
  amount_cents: number;
  expected_book_hash: string;
  reference: string;
  description: string;
  day: string;
  /** Monto del asiento con signo (GL): el neteo mezcla depósitos y reembolsos. */
  book_amount_cents: number;
};

export type SuggestAllocation = {
  statement_line_id: string;
  book_kind: "journal_line";
  book_id: string;
  amount_cents: number;
  expected_book_hash: string;
};

export type LineSuggestion =
  | {
      line_id: string;
      kind: "match";
      stage: SuggestStage;
      candidates: SuggestCandidate[];
      alternatives: [];
    }
  | {
      line_id: string;
      kind: "ambiguous";
      stage: SuggestStage;
      candidates: [];
      /** Cada alternativa es un candidato completo; el contador elige uno. */
      alternatives: SuggestCandidate[];
    }
  | { line_id: string; kind: "none"; candidates: []; alternatives: [] };

export type SuggestParams = {
  toleranceDays: number;
  /** Un BP-#### del POS (cheque en tránsito, sin número) se cobra semanas después. */
  bpToleranceDays: number;
  /** referencia del libro (BP-####) → número de cheque real (vía la copia de QB reversada). */
  posCheckNo: ReadonlyMap<string, string>;
  /** Asientos anulados al cierre (reversa o reversados ≤ to): nunca se proponen. */
  canceled: ReadonlySet<string>;
};

export type SuggestPlan = {
  engine_version: string;
  allocations: SuggestAllocation[];
  ambiguous: Array<{ line: StatementLine; candidates: StatementBookItem[] }>;
  /** Una entrada por línea del extracto (también las ya casadas → `none`). */
  by_line: Map<string, LineSuggestion>;
};

/** Cambiar cualquier etapa cambia esta versión: las sugerencias persistidas la llevan. */
export const SUGGEST_ENGINE_VERSION = "2026-09-15.1";
