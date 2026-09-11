/**
 * verify-mod-dispatch-defer.ts
 *
 * ── Por qué existe (2026-09-11) ──────────────────────────────────────────────
 * El dispatcher del cron esperaba hasta 5 min dentro de `pollUntilQbConfirmed`
 * una confirmación que sólo OTRO job programado podía escribir. Medusa corre
 * los scheduled jobs de a uno en el worker, así que cada edit de estimate/orden
 * congelaba TODO el cron por minuto (Meili sync, reconcilers, pollers de QB,
 * GL) durante esos 5 min — medido: 26/26 mods confirmados a 301–303 s durante
 * 7 días, dos edits seguidos frenaban el worker 10 min.
 *
 * La regla que este verificador protege: el dispatcher NUNCA espera una
 * confirmación en el camino del cron. Antes de tocar el bridge, la fila pasa
 * por `gateModDispatch`: con una operación más vieja en vuelo sobre el mismo
 * documento se difiere (pending + next_retry_at) en vez de bloquear el tick,
 * y tras el submit el callback vuelve — el submitted-poller confirma en el
 * minuto siguiente. Es un check ESTÁTICO a propósito: la regresión no rompía
 * ningún test ni tipo, sólo colgaba el worker en producción.
 *
 * Run (sin DB): ./node_modules/.bin/tsx src/scripts/verify/verify-mod-dispatch-defer.ts
 * Run (con medición real, read-only): agregar --prod [--since <ISO>]
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");
const failures: string[] = [];
const notes: string[] = [];

function ok(id: string, msg: string): void {
  notes.push(`✅ §${id} ${msg}`);
}
function fail(id: string, msg: string): void {
  failures.push(`❌ §${id} ${msg}`);
}
function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}
/** Descarta líneas de import — mencionar el símbolo ahí no es LLAMARLO. */
function nonImportLines(raw: string): string[] {
  return raw.split("\n").filter((l) => !/^\s*import\b/.test(l) && !/^\s*}\s*from\s/.test(l));
}
/** Índice (en `raw.split("\n")`) de la primera línea no-import que matchea `re`. */
function findLine(raw: string, re: RegExp): number {
  const lines = raw.split("\n");
  return lines.findIndex((l) => !/^\s*import\b/.test(l) && re.test(l));
}

async function main(): Promise<void> {
// ── §1 · cada handler difiere antes de llamar al bridge ──────────────────────
const HANDLERS = [
  { id: "1", rel: "lib/quickbooks/handlers/handle-order-updated.ts" },
  { id: "2", rel: "lib/quickbooks/handlers/handle-draft-order-updated.ts" },
];

for (const { id, rel } of HANDLERS) {
  if (!fs.existsSync(path.join(SRC, rel))) {
    fail(`1${id}`, `${rel} no existe donde se esperaba.`);
    continue;
  }
  const raw = read(rel);
  const lines = raw.split("\n");
  const noImports = nonImportLines(raw).join("\n");

  if (/^\s*import\s*\{[^}]*\bgateModDispatch\b[^}]*\}\s*from\s*["']\.\.\/pipeline\/mod-dispatch-gate["']/m.test(raw)) {
    ok(`1${id}a`, `${rel}: importa gateModDispatch`);
  } else {
    fail(`1${id}a`, `${rel} no importa gateModDispatch desde ../pipeline/mod-dispatch-gate.`);
  }

  const callLine = findLine(raw, /gateModDispatch\s*\(/);
  if (callLine === -1) {
    fail(`1${id}b`, `${rel} no llama a gateModDispatch( fuera de un import.`);
  } else {
    const before = lines.slice(Math.max(0, callLine - 6), callLine).join("\n");
    if (/opts\?\.isCron\s*&&\s*opts\?\.pipelineRowId/.test(before)) {
      ok(`1${id}b`, `${rel}: gateModDispatch( guardado por opts?.isCron && opts?.pipelineRowId`);
    } else {
      fail(`1${id}b`, `${rel}: gateModDispatch( sin el guard opts?.isCron && opts?.pipelineRowId en las 6 líneas previas — se dispararía también inline.`);
    }
  }

  if (/return\s+["']deferred["']/.test(noImports)) {
    ok(`1${id}c`, `${rel}: retorna "deferred" cuando el gate difiere`);
  } else {
    fail(`1${id}c`, `${rel} no tiene un \`return "deferred"\`.`);
  }

  const pollMatches = noImports.match(/pollUntilQbConfirmed\(dispatchRowId\)/g) || [];
  if (pollMatches.length !== 1) {
    fail(`1${id}d`, `${rel}: pollUntilQbConfirmed(dispatchRowId) aparece ${pollMatches.length} veces fuera de imports (esperado: 1).`);
  } else {
    const pollLine = findLine(raw, /pollUntilQbConfirmed\(dispatchRowId\)/);
    const before = lines.slice(Math.max(0, pollLine - 12), pollLine).join("\n");
    if (/if\s*\(\s*opts\?\.isCron\s*\)/.test(before)) {
      ok(`1${id}d`, `${rel}: pollUntilQbConfirmed(dispatchRowId) única, en el else de if (opts?.isCron) — nunca corre en el camino del cron`);
    } else {
      fail(`1${id}d`, `${rel}: pollUntilQbConfirmed(dispatchRowId) sin un if (opts?.isCron) en las 12 líneas previas — podría colgar el worker de nuevo.`);
    }
  }

  if (/Promise<[^>]*"deferred"[^>]*>/.test(raw)) {
    ok(`1${id}e`, `${rel}: el tipo de retorno incluye "deferred"`);
  } else {
    fail(`1${id}e`, `${rel}: la firma de retorno no incluye "deferred".`);
  }

  // §1f — el serializer tampoco puede esperar 5 min en el cron: el gate ya
  // descartó una operación MÁS VIEJA en vuelo, así que lo que quede es un
  // hermano más joven a punto de diferirse. El E2E de tie-break colgó 5 min
  // exactos sin este tope (2026-09-11, corrida 1).
  const waitLine = findLine(raw, /maxWaitMs:\s*MOD_DISPATCH_SERIALIZER_WAIT_MS/);
  const importsWait = /import\s*\{[^}]*\bMOD_DISPATCH_SERIALIZER_WAIT_MS\b[^}]*\}\s*from\s*["']\.\.\/pipeline\/mod-dispatch-gate["']/m.test(raw);
  if (waitLine === -1 || !importsWait) {
    fail(`1${id}f`, `${rel}: withQbSerialized sin maxWaitMs: MOD_DISPATCH_SERIALIZER_WAIT_MS (importado del gate) — el serializer esperaría 5 min dentro del tick.`);
  } else {
    const around = lines.slice(Math.max(0, waitLine - 2), waitLine + 1).join("\n");
    if (/opts\?\.isCron\s*\?/.test(around)) {
      ok(`1${id}f`, `${rel}: withQbSerialized recibe maxWaitMs: MOD_DISPATCH_SERIALIZER_WAIT_MS sólo cuando opts?.isCron`);
    } else {
      fail(`1${id}f`, `${rel}: maxWaitMs: MOD_DISPATCH_SERIALIZER_WAIT_MS sin la condición opts?.isCron — recortaría también la espera de la ruta inline.`);
    }
  }
}

// ── §2 · resubmit-by-step.ts ──────────────────────────────────────────────────
const RESUBMIT_REL = "lib/quickbooks/consolidator/resubmit-by-step.ts";
if (!fs.existsSync(path.join(SRC, RESUBMIT_REL))) {
  fail("2", `${RESUBMIT_REL} no existe donde se esperaba.`);
} else {
  const raw = read(RESUBMIT_REL);
  const CATCH_MARK = "} catch (err: any) {";
  const catchIdx = raw.lastIndexOf(CATCH_MARK);
  if (catchIdx === -1) {
    fail("2", `${RESUBMIT_REL}: no se encontró \`${CATCH_MARK}\` — el catch de resubmitByStep cambió de firma.`);
  } else {
    const body = raw.slice(catchIdx + CATCH_MARK.length);
    const vbpcIdx = body.indexOf('row.step === "vendor_bill_payment_check"');
    const forIdx = body.indexOf("failOrRetryPipelineRow(");
    if (vbpcIdx !== -1 && forIdx !== -1 && vbpcIdx < forIdx) {
      ok("2a", `${RESUBMIT_REL}: vendor_bill_payment_check se clasifica antes del primer failOrRetryPipelineRow( — un fetch failed de sólo lectura se reintenta, no muere terminal.`);
    } else {
      fail("2a", `${RESUBMIT_REL}: vendor_bill_payment_check no aparece antes del primer failOrRetryPipelineRow( en el catch — terminaría la fila (12h hasta re-elect) en vez de reintentarla.`);
    }
    if (/failPipelineRow\(row\.id,\s*message\)/.test(body)) {
      ok("2b", `${RESUBMIT_REL}: el catch sigue ruteando el resto de los steps a failPipelineRow(row.id, message)`);
    } else {
      fail("2b", `${RESUBMIT_REL}: se perdió la rama por defecto a failPipelineRow(row.id, message).`);
    }
    if (/describeDispatchError\(/.test(body)) {
      ok("2c", `${RESUBMIT_REL}: el catch llama a describeDispatchError(`);
    } else {
      fail("2c", `${RESUBMIT_REL}: el catch no llama a describeDispatchError( — se pierde el código de causa.`);
    }
  }

  for (const caseLabel of ['case "sales_order_mod":', 'case "estimate_mod":']) {
    const start = raw.indexOf(caseLabel);
    if (start === -1) {
      fail("2d", `${RESUBMIT_REL}: no se encontró ${caseLabel}.`);
      continue;
    }
    const nextCase = raw.indexOf('case "', start + caseLabel.length);
    const block = raw.slice(start, nextCase === -1 ? undefined : nextCase);
    if (/outcome\s*===\s*["']deferred["']/.test(block)) {
      ok("2d", `${RESUBMIT_REL}: ${caseLabel} maneja outcome === "deferred"`);
    } else {
      fail("2d", `${RESUBMIT_REL}: ${caseLabel} no maneja outcome === "deferred" — la fila diferida se marcaría failed en vez de esperar el próximo tick.`);
    }
  }
}

// ── §3 · mod-dispatch-gate.ts ─────────────────────────────────────────────────
const GATE_REL = "lib/quickbooks/pipeline/mod-dispatch-gate.ts";
if (!fs.existsSync(path.join(SRC, GATE_REL))) {
  fail("3", `${GATE_REL} no existe donde se esperaba.`);
} else {
  const raw = read(GATE_REL);
  for (const sym of ["decideModDispatch", "gateModDispatch", "findOldestInFlightSibling", "MOD_DISPATCH_DEFER_SECONDS"]) {
    const re = new RegExp(`export\\s+(async\\s+function|function|const)\\s+${sym}\\b`);
    if (re.test(raw)) ok("3", `${GATE_REL}: exporta ${sym}`);
    else fail("3", `${GATE_REL}: no exporta ${sym}.`);
  }
  if (/ORDER BY created_at ASC/.test(raw)) {
    ok("3", `${GATE_REL}: el SQL del sibling ordena created_at ASC — el más viejo gana el empate.`);
  } else {
    fail("3", `${GATE_REL}: el SQL del sibling no ordena created_at ASC.`);
  }
  const livenessOk = raw.includes("'processing'") && raw.includes("'submitted'") && raw.includes("bridge_op_id IS NOT NULL");
  if (livenessOk) {
    ok("3", `${GATE_REL}: liveness cubre 'processing', 'submitted' y bridge_op_id IS NOT NULL`);
  } else {
    fail("3", `${GATE_REL}: el predicado de liveness no cubre los tres términos esperados.`);
  }
  try {
    const mod = await import("../../lib/quickbooks/pipeline/mod-dispatch-gate");
    if (mod.MOD_DISPATCH_DEFER_SECONDS === 60) {
      ok("3", `${GATE_REL}: MOD_DISPATCH_DEFER_SECONDS === 60`);
    } else {
      fail("3", `${GATE_REL}: MOD_DISPATCH_DEFER_SECONDS === ${String(mod.MOD_DISPATCH_DEFER_SECONDS)}, se esperaba 60.`);
    }
  } catch (err) {
    fail("3", `no se pudo importar ${GATE_REL} dinámicamente: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── §4 · --prod: latencia REAL de confirmación de los mods (read-only) ───────
async function runProdCheck(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--prod")) return;
  if (!process.env.DATABASE_URL) {
    fail("4", `--prod pedido pero DATABASE_URL no está seteado.`);
    return;
  }
  const sinceIdx = args.indexOf("--since");
  const sinceArg = sinceIdx !== -1 ? args[sinceIdx + 1] : undefined;
  const since = sinceArg ? new Date(sinceArg) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (Number.isNaN(since.getTime())) {
    fail("4", `--since recibió una fecha inválida.`);
    return;
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string; p50: string | null; p90: string | null }>(
      `SELECT count(*) AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM confirmed_at - submitted_at)) AS p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM confirmed_at - submitted_at)) AS p90
         FROM qb_order_pipeline
        WHERE step IN ('sales_order_mod', 'estimate_mod')
          AND status = 'confirmed'
          AND confirmed_at > $1`,
      [since.toISOString()]
    );
    const n = Number(rows[0]?.n ?? 0);
    const p50 = rows[0]?.p50 != null ? Number(rows[0].p50) : null;
    const p90 = rows[0]?.p90 != null ? Number(rows[0].p90) : null;
    if (n < 3) {
      notes.push(`⚪ §4 INCONCLUSIVE (n<3) — n=${n} confirmaciones desde ${since.toISOString()}`);
      return;
    }
    if (p50 !== null && p50 < 120) {
      ok("4", `p50=${p50.toFixed(1)}s p90=${p90 !== null ? p90.toFixed(1) : "?"}s sobre n=${n} desde ${since.toISOString()} — el gate evita la espera de 5 min.`);
    } else {
      fail("4", `p50=${p50 !== null ? p50.toFixed(1) : "?"}s (n=${n}) desde ${since.toISOString()} — sigue >= 120s.`);
    }
  } finally {
    await client.end();
  }
}
await runProdCheck();

// ── Reporte ────────────────────────────────────────────────────────────────
console.log("=== verify-mod-dispatch-defer ===\n");
for (const n of notes) console.log("  " + n);
if (failures.length > 0) {
  console.log("");
  for (const f of failures) console.log("  " + f);
  console.log(`\n${failures.length} check(s) fallaron de ${failures.length + notes.length}.`);
  process.exit(1);
}
console.log(`\n✅ ${notes.length} check(s) OK — el dispatcher de mods nunca espera una confirmación en el camino del cron.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
