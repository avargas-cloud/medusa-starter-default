/**
 * verify-qbxml-escaping.ts
 *
 * Afirma que ningún valor se interpola CRUDO dentro de un elemento QBXML.
 *
 * ## Qué falla esto
 *
 * `<RefNumber>${ref}</RefNumber>` con `ref` viniendo de `req.body`. Un valor con
 * `</RefNumber></InvoiceQueryRq><...Rq>` cierra el elemento e inyecta un nodo de
 * request HERMANO en el sobre que el bridge reenvía VERBATIM a QuickBooks
 * Desktop de producción — y `onError="stopOnError"` sólo frena en el PRIMER
 * fallo, así que un nodo bien formado se ejecuta.
 *
 * Estaba en tres rutas el 2026-09-05. Lo que lo delata como olvido y no como
 * decisión: `lookup/route.ts` DEFINE su propio `escapeXml` y lo usaba en tres de
 * sus cuatro interpolaciones.
 *
 * ## Cómo decide
 *
 * Busca `<Tag>${...}</Tag>` en todo el árbol de QuickBooks y exige que la
 * expresión interpolada pase por `escapeXml(`. Hay dos formas legítimas de
 * quedar afuera y las dos son EXPLÍCITAS, nunca inferidas:
 *
 *  - un valor ya probado numérico o de un enum cerrado, declarado en
 *    `NUMERIC_OR_ENUM_EXPRESSIONS` con su motivo;
 *  - una constante literal sin `${}`, que ni entra al barrido.
 *
 * Un valor "obviamente seguro" que nadie declaró se reporta igual: la lista es
 * el registro de quién lo pensó, y sin eso el check se vuelve una opinión.
 *
 * ## Correr
 *
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-qbxml-escaping.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  join(process.cwd(), "src", "api", "admin", "quickbooks"),
  join(process.cwd(), "src", "lib", "quickbooks"),
];

/**
 * Interpolaciones que NO necesitan `escapeXml`, con su motivo verificado.
 *
 * La clave es `<ruta relativa>::<expresión>`, NUNCA la expresión sola. En la
 * primera versión de este archivo estaba keyeado sólo por expresión y el motivo
 * de `fromDate` —"derivado de `year`, validado 2000-2100"— se aplicó también al
 * `fromDate` de `reverse-void-sweep.ts`, que no tiene nada que ver: una exención
 * escrita para un archivo estaba exonerando a otro sin que nadie lo mirara. Un
 * motivo vale para el sitio donde se comprobó y para ninguno más.
 *
 * Cada entrada se verificó leyendo el código el 2026-09-05.
 */
const EXEMPT: Map<string, string> = new Map([
  // Fechas derivadas de `year`, que la ruta valida `Number.isInteger` 2000-2100.
  [
    "src/api/admin/quickbooks/import/payments/route.ts::fromDate",
    "derivado de `year`, validado entero 2000-2100 en el handler",
  ],
  [
    "src/api/admin/quickbooks/import/payments/route.ts::toDate",
    "derivado de `year`, validado entero 2000-2100 en el handler",
  ],
  // DATE_RE es `^\d{4}-\d{2}-\d{2}$` — ANCLADO. Probado: rechaza
  // "2026-01-01</ToTxnDate></X><Inject/>".
  [
    "src/api/admin/quickbooks/search-by-date/route.ts::date",
    "DATE_RE anclado ^\\d{4}-\\d{2}-\\d{2}$ antes de interpolar",
  ],
  [
    "src/api/admin/quickbooks/search-payments/route.ts::date",
    "DATE_RE anclado ^\\d{4}-\\d{2}-\\d{2}$ antes de interpolar",
  ],
  // Enteros validados por rango, que tiran antes de construir el XML.
  [
    "src/lib/quickbooks/qb-terms-add.ts::input.days",
    "Number.isInteger + rango 0-365, tira antes de armar el XML",
  ],
  [
    "src/lib/quickbooks/qb-terms-add.ts::input.dayOfMonthDue",
    "Number.isInteger + rango 1-31, tira antes de armar el XML",
  ],
  [
    "src/lib/quickbooks/qb-terms-add.ts::grace",
    "Number.isInteger + rango 0-31, tira antes de armar el XML",
  ],
  // Composición de hijos YA escapados: `tag()` aplica escapeXml a cada valor.
  [
    'src/lib/quickbooks/qb-vendor-mod.ts::parts.join("")',
    "hijos ya escapados por tag(), que aplica escapeXml a cada valor",
  ],
  // Literales derivados de un booleano o de un número: no hay texto de usuario.
  [
    "src/lib/quickbooks/qb-vendor-mod.ts::vendor.is_active === false ? 0 : 1",
    "ternario sobre booleano, emite el literal 0 o 1",
  ],
  [
    "src/lib/quickbooks/qb-vendor-mod.ts::vendor.is_vendor_eligible_for_1099 ? 1 : 0",
    "ternario sobre booleano, emite el literal 0 o 1",
  ],
  [
    "src/lib/quickbooks/qb-vendor-mod.ts::creditLimit.toFixed(2)",
    "number.toFixed(2) — sólo dígitos y punto",
  ],
  // Ventana calculada por el servidor; ningún callsite la toma de un request.
  [
    "src/lib/quickbooks/reverse-void-sweep.ts::fromDate",
    "ventana calculada por el job/script (day(N)); nunca viene de un request",
  ],
  [
    "src/lib/quickbooks/reverse-void-sweep.ts::toDate",
    "ventana calculada por el job/script (day(N)); nunca viene de un request",
  ],
  [
    "src/lib/quickbooks/reverse-void-sweep.ts::SCAN_MAX_RETURNED",
    "constante del módulo (= 500)",
  ],
  // Nombre de elemento resuelto de un mapa constante del propio archivo.
  [
    "src/api/admin/quickbooks/lookup/route.ts::cfg.queryElement",
    "nombre de elemento, sale de DOC_TYPE_CONFIG (constante)",
  ],
]);

let failures = 0;
let inspected = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

function main(): void {
  console.log("── verify-qbxml-escaping ───────────────────────────────────\n");

  const files = ROOTS.flatMap(listTsFiles);
  check("se encontraron archivos de QuickBooks", files.length > 0, `${files.length} .ts`);

  // `<Tag>${expr}</Tag>` — el nodo cerrado en la misma expresión.
  const interpolation = /<([A-Za-z][A-Za-z0-9]*)>\$\{([^}]*)\}<\/\1>/g;

  for (const file of files) {
    const rel = file.slice(process.cwd().length + 1);
    const source = readFileSync(file, "utf8");

    for (const m of source.matchAll(interpolation)) {
      const [, tag, rawExpr] = m;
      const expr = (rawExpr ?? "").trim();
      inspected++;

      if (expr.includes("escapeXml(")) continue;

      const reason = EXEMPT.get(`${rel}::${expr}`);
      if (reason) {
        console.log(`   ➖ ${rel} <${tag}>\${${expr}} — exento: ${reason}`);
        continue;
      }

      check(
        `   ${rel} <${tag}>\${${expr}} está escapado`,
        false,
        "interpolación cruda en QBXML"
      );
    }
  }

  check(
    "se inspeccionó al menos una interpolación (si no, pasa en vacío)",
    inspected > 0,
    `${inspected} interpolaciones`
  );

  console.log("");
  if (failures > 0) {
    console.log(`❌ ${failures} chequeo(s) fallaron.`);
    process.exit(1);
  }
  console.log(`✅ ${inspected} interpolaciones QBXML, todas escapadas o exentas.`);
}

main();
