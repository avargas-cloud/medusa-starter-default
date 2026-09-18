import {
  CHECK_LITERALS,
  LEGACY_STATUS_ALIASES,
  LOG_SQL,
  PIPELINE_STATUSES,
  PURCHASE_SQL,
  SALES_SQL,
  STATUS_PRESENTATION,
  VOCAB_PHASE,
  WRITE,
  normalizePipelineStatus,
  pipelineStatusIs,
  salesRetryDue,
  salesRetrying,
  salesTerminal,
} from "../../lib/quickbooks/pipeline-status";

/**
 * The vocabulary module is the only place a pipeline status literal may live
 * (plan qb-pipeline-status-vocab-20260917). These tests pin the translation
 * table in BOTH directions and the invariants the cutover depends on:
 * `error` always means "retry scheduled", the expand phase keeps writing the
 * legacy sales `pending`, and every SQL list contains the canonical literal.
 */
describe("pipeline-status vocabulary", () => {
  it("has exactly nine canonical values, each with a presentation", () => {
    expect(PIPELINE_STATUSES).toHaveLength(9);
    for (const s of PIPELINE_STATUSES) expect(STATUS_PRESENTATION[s].label).toBeTruthy();
  });

  it("every legacy alias maps to a canonical value", () => {
    for (const fam of ["sales", "purchase", "log"] as const) {
      for (const canon of Object.values(LEGACY_STATUS_ALIASES[fam])) {
        expect(PIPELINE_STATUSES).toContain(canon);
      }
    }
  });

  describe("normalizePipelineStatus — sales", () => {
    it("pending → waiting (dispatchable)", () => {
      expect(normalizePipelineStatus("sales", "pending")).toBe("waiting");
    });
    it("legacy waiting → blocked in the expand phase", () => {
      if (VOCAB_PHASE === "expand") {
        expect(normalizePipelineStatus("sales", "waiting")).toBe("blocked");
      } else {
        expect(normalizePipelineStatus("sales", "waiting")).toBe("waiting");
      }
    });
    it("confirmed → synced", () => {
      expect(normalizePipelineStatus("sales", "confirmed")).toBe("synced");
    });
    it("failed splits on next_retry_at: retry scheduled → error, none → failed", () => {
      expect(normalizePipelineStatus("sales", "failed", new Date())).toBe("error");
      expect(normalizePipelineStatus("sales", "failed", "2026-09-17T10:00:00Z")).toBe("error");
      expect(normalizePipelineStatus("sales", "failed", null)).toBe("failed");
      expect(normalizePipelineStatus("sales", "failed")).toBe("failed");
    });
    it("canonical values pass through", () => {
      for (const s of PIPELINE_STATUSES) {
        if (s === "waiting") continue; // expand-phase special case above
        expect(normalizePipelineStatus("sales", s)).toBe(s);
      }
    });
    it("unknown literals are returned unchanged, never mapped", () => {
      expect(normalizePipelineStatus("sales", "manual")).toBe("manual");
      expect(normalizePipelineStatus("sales", null)).toBe("");
    });
  });

  describe("normalizePipelineStatus — purchases", () => {
    it.each([
      ["failed_permanent", "failed"],
      ["cancelled", "skipped"],
      ["completed", "synced"],
      ["voided", "synced"],
      ["waiting", "waiting"],
      ["error", "error"],
    ])("%s → %s", (raw, canon) => {
      expect(normalizePipelineStatus("purchase", raw)).toBe(canon);
    });
  });

  it("normalizePipelineStatus — log: completed → synced", () => {
    expect(normalizePipelineStatus("log", "completed")).toBe("synced");
    expect(normalizePipelineStatus("log", "failed")).toBe("failed");
  });

  it("pipelineStatusIs reads next_retry_at off the row", () => {
    expect(pipelineStatusIs("sales", { status: "failed", next_retry_at: new Date() }, "error")).toBe(true);
    expect(pipelineStatusIs("sales", { status: "failed", next_retry_at: null }, "error")).toBe(false);
    expect(pipelineStatusIs("sales", { status: "confirmed" }, "synced", "fixed")).toBe(true);
    expect(pipelineStatusIs("purchase", { status: "failed_permanent" }, "failed")).toBe(true);
  });

  describe("SQL fragments", () => {
    const has = (list: string, lit: string) => list.split(",").map((s) => s.trim()).includes(`'${lit}'`);

    it("expand phase: sales lists carry both spellings; contract: canonical only", () => {
      if (VOCAB_PHASE === "expand") {
        expect(has(SALES_SQL.synced, "confirmed")).toBe(true);
        expect(has(SALES_SQL.blocked, "waiting")).toBe(true);
        expect(has(SALES_SQL.dispatchable, "pending")).toBe(true);
        expect(has(SALES_SQL.dispatchable, "waiting")).toBe(false); // legacy waiting = blocked
        expect(WRITE.sales.dispatchable).toBe("pending");
        expect(has(PURCHASE_SQL.failed, "failed_permanent")).toBe(true);
        expect(has(PURCHASE_SQL.skipped, "cancelled")).toBe(true);
        expect(has(LOG_SQL.synced, "completed")).toBe(true);
      } else {
        expect(has(SALES_SQL.synced, "confirmed")).toBe(false);
        expect(has(SALES_SQL.blocked, "waiting")).toBe(false);
        expect(has(SALES_SQL.dispatchable, "waiting")).toBe(true);
        expect(has(SALES_SQL.dispatchable, "pending")).toBe(false); // sealed
        expect(WRITE.sales.dispatchable).toBe("waiting");
        expect(has(PURCHASE_SQL.failed, "failed_permanent")).toBe(false);
        expect(has(LOG_SQL.synced, "completed")).toBe(false);
      }
    });

    it("every list contains its canonical literal", () => {
      expect(has(SALES_SQL.synced, "synced")).toBe(true);
      expect(has(SALES_SQL.blocked, "blocked")).toBe(true);
      expect(has(SALES_SQL.skipped, "skipped")).toBe(true);
      expect(has(SALES_SQL.retryable, "error")).toBe(true);
      expect(has(SALES_SQL.failedAny, "error")).toBe(true);
      expect(has(SALES_SQL.failedAny, "failed")).toBe(true);
      expect(has(SALES_SQL.inFlight, "blocked")).toBe(true);
      expect(has(PURCHASE_SQL.failed, "failed")).toBe(true);
      expect(has(PURCHASE_SQL.skipped, "skipped")).toBe(true);
      expect(has(PURCHASE_SQL.modSynced, "synced")).toBe(true);
      expect(has(PURCHASE_SQL.voidSynced, "synced")).toBe(true);
      expect(has(LOG_SQL.synced, "synced")).toBe(true);
    });

    it("the live-row exclusion matches the UNIQUE indexes (failed, skipped) — error rows are LIVE", () => {
      expect(SALES_SQL.notLive).toBe("'failed', 'skipped'");
    });

    it("retry predicates always require next_retry_at for a retry", () => {
      expect(salesRetryDue("p.")).toContain("p.next_retry_at IS NOT NULL");
      expect(salesRetryDue("p.")).toContain("p.next_retry_at <= NOW()");
      expect(salesRetrying()).toContain("status");
      expect(salesTerminal("x.")).toContain("x.status = 'failed'");
      if (VOCAB_PHASE === "expand") expect(salesTerminal()).toContain("next_retry_at IS NULL");
    });
  });

  it("WRITE never emits a legacy literal except the expand-phase sales dispatchable", () => {
    const legacy = new Set(["confirmed", "failed_permanent", "cancelled", "completed", "voided"]);
    for (const fam of ["sales", "purchase", "log"] as const) {
      for (const [k, v] of Object.entries(WRITE[fam])) {
        if (fam === "sales" && k === "dispatchable") continue;
        expect(legacy.has(v)).toBe(false);
        expect(PIPELINE_STATUSES).toContain(v);
      }
    }
  });

  it("CHECK literal lists: expand ⊇ contract, both ⊇ canonical", () => {
    for (const key of Object.keys(CHECK_LITERALS.expand) as Array<keyof typeof CHECK_LITERALS.expand>) {
      const ex = CHECK_LITERALS.expand[key] as readonly string[];
      const co = CHECK_LITERALS.contract[key] as readonly string[];
      for (const s of PIPELINE_STATUSES) {
        expect(ex).toContain(s);
        expect(co).toContain(s);
      }
      for (const s of co) expect(ex).toContain(s);
    }
  });
});
