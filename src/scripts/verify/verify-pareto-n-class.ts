/**
 * verify-pareto-n-class — invariantes de la clase XYZ 'N' en purchasing_snapshot.
 *
 * Correr con:
 *   env DATABASE_URL="..." ./node_modules/.bin/tsx src/scripts/verify/verify-pareto-n-class.ts
 *
 * Invariantes:
 *   1. Ninguna fila 'N' con cv_points >= MIN_CV_POINTS (una N ganada con
 *      historia suficiente es un bug del motor).
 *   2. Ninguna fila X/Y/Z recalculada (cv_points NOT NULL) con
 *      cv_points < MIN_CV_POINTS (una letra afirmada sin historia es el bug
 *      original que la N reemplaza).
 *   3. Toda abcxyz_class es consistente con sus dos letras.
 *   4. El CHECK de la tabla acepta 'N' (la migración corrió).
 */
import { Client } from "pg";

import { MIN_CV_POINTS } from "../../services/purchasing/pareto-engine";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("FAIL: DATABASE_URL no seteada");
    process.exit(1);
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  let failures = 0;

  const check = async (name: string, sql: string, expectZero = true) => {
    const res = await db.query<{ n: string }>(sql);
    const n = parseInt(res.rows[0]?.n ?? "0", 10);
    const ok = expectZero ? n === 0 : n > 0;
    console.log(`${ok ? "PASS" : "FAIL"}: ${name} (${n})`);
    if (!ok) failures++;
  };

  await check(
    `ninguna 'N' con cv_points >= ${MIN_CV_POINTS}`,
    `SELECT count(*)::text AS n FROM purchasing_snapshot
     WHERE xyz_class = 'N' AND cv_points >= ${MIN_CV_POINTS}`
  );
  await check(
    `ninguna X/Y/Z recalculada con cv_points < ${MIN_CV_POINTS}`,
    `SELECT count(*)::text AS n FROM purchasing_snapshot
     WHERE xyz_class IN ('X','Y','Z') AND cv_points IS NOT NULL
       AND cv_points < ${MIN_CV_POINTS}`
  );
  await check(
    "abcxyz_class consistente con abc_class + xyz_class",
    `SELECT count(*)::text AS n FROM purchasing_snapshot
     WHERE abc_class IS NOT NULL AND xyz_class IS NOT NULL
       AND abcxyz_class IS DISTINCT FROM (abc_class || xyz_class)`
  );
  await check(
    "el CHECK de xyz_class acepta 'N' (migración aplicada)",
    `SELECT count(*)::text AS n FROM pg_constraint
     WHERE conrelid = 'purchasing_snapshot'::regclass
       AND conname = 'purchasing_snapshot_xyz_class_check'
       AND pg_get_constraintdef(oid) LIKE '%''N''%'`,
    false
  );

  const dist = await db.query<{ xyz_class: string | null; n: string }>(
    `SELECT xyz_class, count(*)::text AS n FROM purchasing_snapshot
     GROUP BY xyz_class ORDER BY xyz_class NULLS FIRST`
  );
  console.log(
    "distribución:",
    dist.rows.map((r) => `${r.xyz_class ?? "null"}=${r.n}`).join(" ")
  );

  await db.end();
  if (failures > 0) {
    console.error(`FAIL: ${failures} invariante(s) rotas`);
    process.exit(1);
  }
  console.log("OK: clase N consistente");
}

void main();
