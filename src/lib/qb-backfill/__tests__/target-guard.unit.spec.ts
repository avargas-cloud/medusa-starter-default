import {
  assertDryRunEvidence,
  describeDbTarget,
  isSandboxDatabaseUrl,
  resolveWriteTarget,
  WriteTargetError,
} from "../target-guard";

const SANDBOX_URL = "postgresql://postgres:sandbox@localhost:5499/medusa_bankgl";
const SANDBOX_URL_127 = "postgresql://postgres:sandbox@127.0.0.1:5499/medusa";
const PROD_URL = "postgresql://postgres:s3cr3t-pass@caboose.proxy.rlwy.net:41234/railway";
const RUN = "qbbf-20260911";

const resolve = (over: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  databaseUrl?: string | undefined;
  runId?: string | undefined;
}) =>
  resolveWriteTarget({
    argv: over.argv ?? ["node", "script.ts", "--apply"],
    env: over.env ?? {},
    databaseUrl: "databaseUrl" in over ? over.databaseUrl : SANDBOX_URL,
    runId: "runId" in over ? over.runId : RUN,
  });

const failuresOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    if (err instanceof WriteTargetError) return err.failures;
    throw err;
  }
  throw new Error("no tiró");
};

describe("resolveWriteTarget — sandbox (default, sin flag)", () => {
  it("ECOPOWERTECH_ENV=sandbox + localhost:5499 → sandbox (igual que hoy)", () => {
    const r = resolve({ env: { ECOPOWERTECH_ENV: "sandbox" } });
    expect(r.target).toBe("sandbox");
    expect(r.dbTarget).toBe("localhost:5499/medusa_bankgl");
  });

  it("127.0.0.1:5499 también es sandbox", () => {
    expect(resolve({ env: { ECOPOWERTECH_ENV: "sandbox" }, databaseUrl: SANDBOX_URL_127 }).target).toBe("sandbox");
  });

  it("sin ECOPOWERTECH_ENV → rechaza y nombra la condición", () => {
    const f = failuresOf(() => resolve({ env: {} }));
    expect(f.some((x) => x.includes("ECOPOWERTECH_ENV debe ser 'sandbox'"))).toBe(true);
  });

  it("ECOPOWERTECH_ENV=production sin flag → rechaza (no se cae a producción por accidente)", () => {
    const f = failuresOf(() => resolve({ env: { ECOPOWERTECH_ENV: "production" }, databaseUrl: PROD_URL }));
    expect(f.some((x) => x.includes("ECOPOWERTECH_ENV debe ser 'sandbox'"))).toBe(true);
    expect(f.some((x) => x.includes("localhost:5499"))).toBe(true);
  });

  it("ECOPOWERTECH_ENV=sandbox pero DATABASE_URL fuera de :5499 → rechaza sin imprimir credenciales", () => {
    const f = failuresOf(() => resolve({ env: { ECOPOWERTECH_ENV: "sandbox" }, databaseUrl: PROD_URL }));
    const joined = f.join("\n");
    expect(joined).toContain("caboose.proxy.rlwy.net:41234/railway");
    expect(joined).not.toContain("s3cr3t-pass");
  });

  it("sin DATABASE_URL → rechaza", () => {
    const f = failuresOf(() => resolve({ env: { ECOPOWERTECH_ENV: "sandbox" }, databaseUrl: undefined }));
    expect(f.some((x) => x.includes("DATABASE_URL es obligatoria"))).toBe(true);
  });

  it("CONFIRM_PRODUCTION_RUN sin flag no cambia nada: sigue siendo sandbox", () => {
    const r = resolve({ env: { ECOPOWERTECH_ENV: "sandbox", CONFIRM_PRODUCTION_RUN: RUN } });
    expect(r.target).toBe("sandbox");
  });
});

describe("resolveWriteTarget — production (--target-production / TARGET_PRODUCTION=1)", () => {
  const PROD_ENV = { ECOPOWERTECH_ENV: "production", CONFIRM_PRODUCTION_RUN: RUN };
  const PROD_ARGV = ["node", "script.ts", "--apply", "--target-production"];

  it("todas las condiciones → production", () => {
    const r = resolve({ argv: PROD_ARGV, env: PROD_ENV, databaseUrl: PROD_URL });
    expect(r.target).toBe("production");
    expect(r.dbTarget).toBe("caboose.proxy.rlwy.net:41234/railway");
    expect(r.reason).not.toContain("s3cr3t-pass");
  });

  it("TARGET_PRODUCTION=1 equivale al flag (scripts bajo medusa exec)", () => {
    const r = resolve({ argv: ["node", "medusa", "exec"], env: { ...PROD_ENV, TARGET_PRODUCTION: "1" }, databaseUrl: PROD_URL });
    expect(r.target).toBe("production");
  });

  it("(1) flag con ECOPOWERTECH_ENV=sandbox → rechaza", () => {
    const f = failuresOf(() => resolve({ argv: PROD_ARGV, env: { ...PROD_ENV, ECOPOWERTECH_ENV: "sandbox" }, databaseUrl: PROD_URL }));
    expect(f).toEqual([expect.stringContaining("ECOPOWERTECH_ENV debe ser 'production' (es 'sandbox')")]);
  });

  it("(2) todo bien pero DATABASE_URL en :5499 → rechaza", () => {
    const f = failuresOf(() => resolve({ argv: PROD_ARGV, env: PROD_ENV, databaseUrl: SANDBOX_URL }));
    expect(f.some((x) => x.includes("puerto del sandbox"))).toBe(true);
    expect(f.some((x) => x.includes("contiene 'sandbox'"))).toBe(true);
  });

  it("DATABASE_URL con 'sandbox' en el nombre de la base (otro puerto) → rechaza", () => {
    const f = failuresOf(() =>
      resolve({ argv: PROD_ARGV, env: PROD_ENV, databaseUrl: "postgresql://u:p@db.internal:5432/medusa_sandbox" })
    );
    expect(f).toEqual([expect.stringContaining("contiene 'sandbox'")]);
  });

  it("(3a) CONFIRM_PRODUCTION_RUN ausente → rechaza", () => {
    const f = failuresOf(() => resolve({ argv: PROD_ARGV, env: { ECOPOWERTECH_ENV: "production" }, databaseUrl: PROD_URL }));
    expect(f).toEqual([expect.stringContaining("CONFIRM_PRODUCTION_RUN ausente")]);
  });

  it("(3b) CONFIRM_PRODUCTION_RUN distinto del run id → rechaza", () => {
    const f = failuresOf(() =>
      resolve({ argv: PROD_ARGV, env: { ECOPOWERTECH_ENV: "production", CONFIRM_PRODUCTION_RUN: "otro" }, databaseUrl: PROD_URL })
    );
    expect(f).toEqual([expect.stringContaining("no coincide con el run id")]);
  });

  it("run id vacío → rechaza aunque CONFIRM esté", () => {
    const f = failuresOf(() => resolve({ argv: PROD_ARGV, env: PROD_ENV, databaseUrl: PROD_URL, runId: "" }));
    expect(f.some((x) => x.includes("run id vacío"))).toBe(true);
  });

  it("sin DATABASE_URL → rechaza", () => {
    const f = failuresOf(() => resolve({ argv: PROD_ARGV, env: PROD_ENV, databaseUrl: undefined }));
    expect(f).toEqual([expect.stringContaining("DATABASE_URL es obligatoria")]);
  });

  it("varias condiciones malas → las lista TODAS", () => {
    const f = failuresOf(() =>
      resolve({ argv: PROD_ARGV, env: { ECOPOWERTECH_ENV: "sandbox" }, databaseUrl: SANDBOX_URL })
    );
    expect(f.length).toBeGreaterThanOrEqual(4);
    expect(f.join("\n")).not.toContain("postgres:sandbox@");
  });
});

describe("helpers", () => {
  it("describeDbTarget nunca incluye credenciales", () => {
    expect(describeDbTarget(PROD_URL)).toBe("caboose.proxy.rlwy.net:41234/railway");
    expect(describeDbTarget("postgresql://u:p@host/db")).toBe("host:5432/db");
    expect(describeDbTarget("no es url")).toBe("<url ilegible>");
    expect(describeDbTarget(undefined)).toBe("<sin DATABASE_URL>");
  });

  it("isSandboxDatabaseUrl", () => {
    expect(isSandboxDatabaseUrl(SANDBOX_URL)).toBe(true);
    expect(isSandboxDatabaseUrl(SANDBOX_URL_127)).toBe(true);
    expect(isSandboxDatabaseUrl("postgresql://u:p@localhost:5432/medusa")).toBe(false);
    expect(isSandboxDatabaseUrl("postgresql://u:p@remote.host:5499/medusa")).toBe(false);
    expect(isSandboxDatabaseUrl(undefined)).toBe(false);
  });
});

describe("assertDryRunEvidence", () => {
  it("sandbox: no exige nada", () => {
    const lines: string[] = [];
    expect(() => assertDryRunEvidence("sandbox", RUN, null, (l) => lines.push(l))).not.toThrow();
    expect(lines).toEqual([]);
  });

  it("production sin evidencia → 'corré el dry-run primero'", () => {
    const f = failuresOf(() => assertDryRunEvidence("production", RUN, null, () => undefined));
    expect(f).toEqual([expect.stringContaining("corré el dry-run primero")]);
  });

  it("production con evidencia → imprime path y cardinalidad", () => {
    const lines: string[] = [];
    assertDryRunEvidence("production", RUN, { path: "/x/report.json", cardinality: { a_crear: 12, bloqueados: 0 } }, (l) =>
      lines.push(l)
    );
    expect(lines[0]).toContain("/x/report.json");
    expect(lines).toContain("  a_crear: 12");
    expect(lines).toContain("  bloqueados: 0");
  });
});
