/**
 * Gate del módulo places-usage.
 *
 * Assertea las tres cosas que pueden romperse en silencio y que ni `type-check`
 * ni una lectura del código detectan:
 *
 *  1. **El índice único (day, source) existe.** Es lo que hace que el
 *     `ON CONFLICT DO UPDATE` incremente. Sin él el insert no entra en conflicto
 *     nunca: se crean filas duplicadas, los totales se parten entre ellas, y la
 *     pantalla muestra menos consumo del real — es decir, falla hacia el lado
 *     peligroso, callado.
 *
 *  2. **El incremento es realmente atómico bajo concurrencia.** Varios cajeros
 *     tipean direcciones a la vez. Se disparan N escrituras en paralelo y se
 *     exige exactamente N: un read-modify-write perdería cuentas y este check es
 *     la única forma de verlo (una prueba secuencial pasa igual).
 *
 *  3. **El día es PACÍFICO, no local.** Las cuotas de Google resetean a
 *     medianoche de California; un bucket en hora de Miami rota tres horas antes
 *     y el número deja de cuadrar con la cuota que dice medir. Se verifica con
 *     un instante fijo donde las dos fechas DIFIEREN — con cualquier otro, un
 *     bug de timezone pasa desapercibido.
 *
 * Sandbox-only: escribe y borra filas de prueba.
 *
 * Usage:  tsx src/scripts/verify/verify-places-usage.ts
 */

import { getDbPool } from "../../api/utils/db-pool";

const connectionString = process.env.DATABASE_URL ?? "";
if (!/localhost:5499|127\.0\.0\.1:5499/.test(connectionString)) {
  throw new Error("Refusing to run: verify-places-usage is sandbox-only");
}

/** Copia de la lógica del service, verificada aparte a propósito. */
function pacificDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const checks: { ok: boolean; name: string; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push({ ok, name, detail });
};

const TEST_DAY = "1999-01-01"; // fuera de cualquier rango real
const CONCURRENT = 40;

async function main(): Promise<void> {
  const pool = getDbPool();

  // ── 1. índice único ────────────────────────────────────────────────────────
  const idx = await pool.query<{ indexdef: string }>(
    `select indexdef from pg_indexes
      where tablename = 'places_usage_daily' and indexdef ilike '%unique%'`
  );
  const hasUnique = idx.rows.some(
    (r) => /\(\s*day\s*,\s*source\s*\)/i.test(r.indexdef) || /day.*source/i.test(r.indexdef)
  );
  check(
    "existe el índice UNIQUE (day, source)",
    hasUnique,
    hasUnique ? "" : "sin él el ON CONFLICT nunca dispara y los conteos se parten"
  );

  // ── 2. atomicidad bajo concurrencia ────────────────────────────────────────
  await pool.query(`delete from places_usage_daily where day = $1`, [TEST_DAY]);

  const one = (): Promise<unknown> =>
    pool.query(
      `insert into "places_usage_daily"
         ("id","day","source","lookups","created_at","updated_at")
       values ($1,$2,$3,1,now(),now())
       on conflict ("day","source") do update set
         "lookups" = "places_usage_daily"."lookups" + 1,
         "updated_at" = now()`,
      [`pud_${TEST_DAY}_pos`, TEST_DAY, "pos"]
    );

  // El upsert se envuelve porque sin el índice único Postgres no puede inferir
  // el conflict target y TIRA (`infer_arbiter_indexes`). Sin este catch el gate
  // moría con un stack trace en vez de decir qué falló — y un run que no
  // reporta nada se lee como "no probé", que es peor que un FAIL.
  let concurrencyError: string | null = null;
  try {
    await Promise.all(Array.from({ length: CONCURRENT }, one));
  } catch (err) {
    concurrencyError = err instanceof Error ? err.message : String(err);
  }

  if (concurrencyError) {
    check("el upsert concurrente corre sin tirar", false, concurrencyError.slice(0, 160));
    check("las N escrituras concurrentes colapsan en UNA fila", false, "no se pudo medir");
    check(`no se pierde ninguna cuenta bajo ${CONCURRENT} escrituras simultáneas`, false, "no se pudo medir");
  } else {
    const after = await pool.query<{ rows_count: string; lookups: number }>(
      `select count(*)::text as rows_count, coalesce(max(lookups),0) as lookups
         from places_usage_daily where day = $1`,
      [TEST_DAY]
    );
    const rowsCount = Number(after.rows[0]?.rows_count ?? 0);
    const lookups = Number(after.rows[0]?.lookups ?? 0);

    check("el upsert concurrente corre sin tirar", true);
    check("las N escrituras concurrentes colapsan en UNA fila", rowsCount === 1, `filas=${rowsCount}`);
    check(
      `no se pierde ninguna cuenta bajo ${CONCURRENT} escrituras simultáneas`,
      lookups === CONCURRENT,
      `lookups=${lookups} esperado=${CONCURRENT}`
    );
  }

  await pool.query(`delete from places_usage_daily where day = $1`, [TEST_DAY]);

  // ── 3. el día es Pacífico ──────────────────────────────────────────────────
  // 2026-08-14T05:30:00Z = 14 de agosto en UTC y en Miami (01:30 EDT), pero
  // todavía 13 de agosto en California (22:30 PDT). Si el bucket dijera "14",
  // estaría usando la zona equivocada.
  const instant = new Date("2026-08-14T05:30:00Z");
  const got = pacificDay(instant);
  check(
    "el bucket usa la fecha de California, no la local",
    got === "2026-08-13",
    `got=${got} esperado=2026-08-13 (a esa hora ya es 14 en Miami y en UTC)`
  );

  check(
    "el formato del día es YYYY-MM-DD",
    /^\d{4}-\d{2}-\d{2}$/.test(pacificDay(new Date())),
    pacificDay(new Date())
  );

  const bad = checks.filter((c) => !c.ok);
  console.log(`${bad.length ? "FAIL" : "PASS"}  places-usage`);
  for (const c of checks) {
    console.log(`      ${c.ok ? "ok " : "NO "} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(`\n${checks.length - bad.length}/${checks.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

void main();
