import type { MedusaContainer } from "@medusajs/framework/types";

import { readBankingControl } from "../lib/banking/control";
import { bankingConfig } from "../lib/banking/security";
import { runSuggestions } from "../lib/banking/suggestion-runner";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

/**
 * Sugerencias del Bank Feed (plan bank-feed-suggestions-20260915): una vez por día, después del
 * poll de Plaid, mantiene el borrador del mes en curso de cada cuenta (expand-only) y persiste
 * lo que el casador PROPONE por línea. Nunca casa, nunca crea documentos, nunca toca un extracto
 * cerrado — el contador confirma desde el POS. Apagado salvo `BANK_SUGGEST_JOB_ENABLED=true`
 * (además del guard de crons y del kill switch de Banking).
 *
 * 10:30 UTC = 06:30 ET en horario de verano (05:30 en invierno): el feed ya trajo lo de ayer.
 */
export default async function bankStatementSuggest(container: MedusaContainer): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  if (process.env.BANK_SUGGEST_JOB_ENABLED !== "true") return;
  if (!bankingConfig().enabled) return;
  if (!(await readBankingControl()).enabled) return;
  const logger = container.resolve("logger");
  const reports = await runSuggestions({ trigger: "job", actorId: "system" });
  for (const r of reports) {
    const o = r.outcome;
    logger.info(
      `[BANK-SUGGEST] *${r.mask} ${r.month} ${o.status}${o.status === "ok" ? ` lines=${o.lines} appended=${o.appended_lines} matched=${o.matched_lines} suggested=${o.suggested_lines} ambiguous=${o.ambiguous_lines}` : o.status === "skipped" ? ` (${o.skipped_reason})` : ` ${o.error}`}`
    );
  }
}
export const config = { name: "bank-statement-suggest", schedule: "30 10 * * *" };
