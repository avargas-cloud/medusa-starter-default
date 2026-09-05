/**
 * verify-admin-route-pin-coverage.ts
 *
 * Barre TODAS las rutas mutantes de `src/api/admin/**` y las cruza contra el
 * gate de PIN de supervisor. READ-ONLY: reporta, no falla.
 *
 * ## Por qué existe
 *
 * La quinta extensión de `.claude/rules/secrets.md` dejó escrito el defecto que
 * este script ataca: `verify-pin-enforcement.ts` audita **los archivos que
 * MENCIONAN el PIN** y comprueba que ninguno lo compare a mano. Eso es correcto
 * y es estructuralmente ciego a la falla inversa — una ruta que DEBERÍA pedir
 * PIN y no nombra nada nunca entra en su barrido, así que sale limpia. Así vivió
 * `POST /admin/pos/prices/[productId]`, que reprecia el catálogo entero y cuyo
 * único gate era una comparación en React.
 *
 * Este script recorre el árbol al revés: parte de TODAS las rutas que mutan y
 * pregunta cuáles no tienen gate. No puede decidir cuáles lo necesitan —eso es
 * criterio de negocio— así que ordena por señal y deja la decisión al humano.
 *
 * ## Lo que NO hace, dicho de frente
 *
 * No es un gate. No falla el build. Un `exit 0` acá NO significa "todo cubierto":
 * significa "el barrido corrió". Convertirlo en gate exigiría una lista de
 * decisiones tomadas ruta por ruta, y esa lista es el trabajo que este informe
 * habilita, no el que reemplaza.
 *
 * Tampoco distingue una ruta que no necesita PIN de una que lo necesita y no lo
 * tiene: sólo mide el riesgo por el NOMBRE de la ruta, que es una heurística.
 *
 * ## Correr
 *
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-admin-route-pin-coverage.ts
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-admin-route-pin-coverage.ts --all
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ADMIN_DIR = join(process.cwd(), "src", "api", "admin");
const SHOW_ALL = process.argv.includes("--all");

/** Verbos que MUTAN. Un GET no entra al barrido. */
const MUTATING = ["POST", "PATCH", "PUT", "DELETE"];

/**
 * Señales de que una ruta toca algo que el PIN protege.
 * Es una heurística por NOMBRE — su falso negativo es una ruta que mueve dinero
 * y no lo dice en su path, que es exactamente el caso que costó el incidente.
 */
const HIGH_RISK = [
  "price",
  "cost",
  "discount",
  "credit",
  "refund",
  "payment",
  "void",
  "write-off",
  "adjustment",
  "treasury",
  "commission",
  "supervisor",
  "bulk",
  "stores",
];

interface RouteInfo {
  rel: string;
  verbs: string[];
  gated: boolean;
  risky: string[];
}

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listRouteFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/** Descarta imports: importar el guard no es llamarlo. */
function withoutImports(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*import\b/.test(line))
    .join("\n");
}

function main(): void {
  console.log("── verify-admin-route-pin-coverage (READ-ONLY) ─────────────\n");

  const files = listRouteFiles(ADMIN_DIR);
  const routes: RouteInfo[] = [];

  for (const file of files) {
    const rel = file.slice(process.cwd().length + 1);
    const source = readFileSync(file, "utf8");
    const body = withoutImports(source);

    const verbs = MUTATING.filter((v) =>
      new RegExp(`export\\s+(const|async\\s+function)\\s+${v}\\b`).test(source)
    );
    if (verbs.length === 0) continue;

    // Llamada, no mención: el import no cuenta (§4b de verify-pin-enforcement
    // tenía justo ese defecto documentado desde julio).
    const gated =
      /\bguardSupervisorPin\s*\(/.test(body) ||
      /\bverifySupervisorPin\s*\(/.test(body) ||
      /\brequireSupervisorPin\s*\(/.test(body);

    const routePath = rel
      .replace(/^src\/api/, "")
      .replace(/\/route\.ts$/, "")
      .toLowerCase();
    const risky = HIGH_RISK.filter((k) => routePath.includes(k));

    routes.push({ rel, verbs, gated, risky });
  }

  const gated = routes.filter((r) => r.gated);
  const ungated = routes.filter((r) => !r.gated);
  const riskyUngated = ungated.filter((r) => r.risky.length > 0);

  console.log("RESUMEN");
  console.log(`   rutas admin que MUTAN         ${routes.length}`);
  console.log(`   con gate de PIN                ${gated.length}`);
  console.log(`   sin gate de PIN                ${ungated.length}`);
  console.log(`   sin gate Y con nombre de riesgo ${riskyUngated.length}`);

  console.log("\nSIN GATE, CON SEÑAL DE RIESGO EN EL NOMBRE");
  console.log("(revisión humana: cada una es una pregunta, no un hallazgo)\n");
  for (const r of riskyUngated.sort((a, b) => a.rel.localeCompare(b.rel))) {
    console.log(
      `   ${r.verbs.join(",").padEnd(18)} ${r.rel}\n      señales: ${r.risky.join(", ")}`
    );
  }

  console.log("\nCON GATE (referencia de lo que ya está cubierto)\n");
  for (const r of gated.sort((a, b) => a.rel.localeCompare(b.rel))) {
    console.log(`   ${r.verbs.join(",").padEnd(18)} ${r.rel}`);
  }

  if (SHOW_ALL) {
    console.log("\nSIN GATE, SIN SEÑAL DE RIESGO (--all)\n");
    for (const r of ungated
      .filter((x) => x.risky.length === 0)
      .sort((a, b) => a.rel.localeCompare(b.rel))) {
      console.log(`   ${r.verbs.join(",").padEnd(18)} ${r.rel}`);
    }
  } else {
    console.log(
      `\n(${ungated.length - riskyUngated.length} rutas sin gate y sin señal de riesgo — usar --all para verlas)`
    );
  }

  console.log(
    "\nEste script NO es un gate: exit 0 significa que el barrido corrió, no que todo esté cubierto."
  );
}

main();
