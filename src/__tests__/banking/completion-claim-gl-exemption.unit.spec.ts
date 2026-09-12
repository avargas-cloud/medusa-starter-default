import * as mod from "../../lib/banking/completion-claim-sql";

/**
 * qb-gl-import delta v2 (2026-09-11): `BankingOnGlStatements` recrea
 * `bank_completion_claim_insert()` desde este SQL. Si el SQL pierde la
 * exención para documentos del libro (`source_kind IS NOT NULL`), todo cobro
 * del GL (claim `payment_recognition`) muere con BANKING_SOURCE_CLAIM_INVALID
 * — medido en sandbox: 80 de 92 cobros de una semana bloqueados. Este spec
 * fija la forma exacta que puso `GeneralLedgerCore` 1783300000000.
 */
function sqlText(): string {
  const exported = (mod as Record<string, unknown>).completionClaimSql;
  const text = typeof exported === "function" ? (exported as () => string)() : exported;
  if (typeof text !== "string") throw new Error("completionClaimSql no es un string ni una función que devuelva string");
  return text;
}

describe("completion-claim-sql · bank_completion_claim_insert acepta documentos del GL", () => {
  it("rechaza sólo los asientos sin completion_id Y sin source_kind (y los reversals)", () => {
    const sql = sqlText();
    const start = sql.indexOf("FUNCTION bank_completion_claim_insert()");
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf("END $$;", start));
    expect(body).toContain("IF (e.completion_id IS NULL AND e.source_kind IS NULL) OR e.kind='reversal'");
    expect(body).not.toContain("IF e.completion_id IS NULL OR e.kind='reversal'");
    expect(body).toContain("RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'");
  });
});
