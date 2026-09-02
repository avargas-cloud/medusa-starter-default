/**
 * repair-cm-1026-duplicate-lines.ts — borra las 7 líneas duplicadas de CM-1026.
 *
 * DRY-RUN por default. Para aplicar:
 *   env DATABASE_URL="…" APPLY=true ./node_modules/.bin/tsx \
 *     src/scripts/fix/repair-cm-1026-duplicate-lines.ts
 *
 * ── Qué pasó ─────────────────────────────────────────────────────────────────
 *
 * CM-1026 tiene sus 7 ítems insertados DOS VECES: 14 filas, en dos tandas
 * separadas por 21 milisegundos (created_at .794 y .815 del 2026-05-11
 * 22:54:53). Un doble-submit. El encabezado quedó bien —`subtotal` = 19125,
 * que son los 7 ítems reales— y las líneas suman 38250.
 *
 * No mueve ningún total (los reportes de nivel documento leen el encabezado),
 * pero `by-item` y `by-category` atribuyen por LÍNEA, así que le cargaban
 * $191.25 de devolución a productos que nadie devolvió. Es la única nota
 * corrupta de las 141 del histórico; las facturas cierran 1599/1600 y la
 * excepción de ahí ya la resuelve la fórmula de ingreso.
 *
 * ── Por qué NO toca QuickBooks ───────────────────────────────────────────────
 *
 * El payload que se le mandó a QB llevaba 7 líneas —QB nunca vio la
 * duplicación— y además esa nota ya fue anulada allá (`void_credit_memo`
 * confirmado el mismo día). Este script no encola, no re-envía y no voidea
 * nada: sólo saca filas que el propio encabezado de Medusa contradice.
 *
 * ── Cómo elige qué borrar ────────────────────────────────────────────────────
 *
 * Las 14 filas son idénticas en todo salvo el `id` y el microsegundo de
 * `created_at`. Se conserva la PRIMERA tanda y se borra la segunda. El criterio
 * es determinista y se imprime antes de tocar nada; si alguna vez hubiera más
 * de dos tandas, o el conteo no diera exactamente 7 y 7, el script ABORTA en
 * vez de adivinar.
 */

import { writeFileSync } from "fs";

import { Client } from "pg";

const MEMO = "CM-1026";
const ESPERADAS_POR_TANDA = 7;

type Fila = {
  id: string;
  sku: string | null;
  quantity: number;
  unit_price: string;
  line_total: string;
  created_at: string;
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌ Falta DATABASE_URL. Sin destino explícito este script no corre.");
    process.exit(1);
  }
  const apply = process.env.APPLY === "true";
  console.log(`\n🔧 repair ${MEMO} — ${apply ? "APPLY" : "DRY-RUN"} — ${url.replace(/\/\/[^@]*@/, "//***@")}\n`);

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const { rows } = await db.query<Fila>(
      `SELECT cmi.id, cmi.sku, cmi.quantity,
              cmi.unit_price::text, cmi.line_total::text,
              cmi.created_at::text
       FROM pos_credit_memo cm
       JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
       WHERE cm.credit_memo_number = $1
       ORDER BY cmi.created_at, cmi.id`,
      [MEMO]
    );

    const tandas = [...new Set(rows.map((r) => r.created_at))].sort();
    console.log(`  filas vivas: ${rows.length} · tandas distintas: ${tandas.length}`);
    tandas.forEach((t) => console.log(`    ${t} → ${rows.filter((r) => r.created_at === t).length} filas`));

    // Abortar ante cualquier forma que no sea la esperada: 2 tandas de 7.
    if (tandas.length !== 2) {
      console.error(`\n❌ Se esperaban 2 tandas y hay ${tandas.length}. No se toca nada.`);
      process.exit(1);
    }
    const [primera, segunda] = tandas;
    const conservar = rows.filter((r) => r.created_at === primera);
    const borrar = rows.filter((r) => r.created_at === segunda);
    if (conservar.length !== ESPERADAS_POR_TANDA || borrar.length !== ESPERADAS_POR_TANDA) {
      console.error(
        `\n❌ Se esperaban ${ESPERADAS_POR_TANDA} y ${ESPERADAS_POR_TANDA}; hay ${conservar.length} y ${borrar.length}. No se toca nada.`
      );
      process.exit(1);
    }
    // Las dos tandas tienen que ser el MISMO conjunto de ítems, o no son duplicados.
    const firma = (f: Fila[]): string =>
      f.map((r) => `${r.sku}|${r.quantity}|${r.unit_price}|${r.line_total}`).sort().join("\n");
    if (firma(conservar) !== firma(segunda ? borrar : [])) {
      console.error("\n❌ Las dos tandas NO son idénticas ítem por ítem. No son duplicados: abortado.");
      process.exit(1);
    }

    console.log(`\n  se CONSERVA la tanda ${primera} (${conservar.length} filas)`);
    console.log(`  se BORRA    la tanda ${segunda} (${borrar.length} filas):`);
    for (const r of borrar) {
      console.log(`    ${r.id}  ${r.sku}  qty=${r.quantity}  total=${r.line_total}`);
    }

    // El respaldo se escribe SIEMPRE, también en dry-run: es lo que permite
    // reinsertar si algo saliera mal, y tenerlo sólo en la corrida real
    // significaría no tenerlo justo cuando hace falta.
    const dump = `/tmp/cm-1026-lineas-borradas-${Date.now()}.json`;
    writeFileSync(dump, JSON.stringify({ memo: MEMO, conservadas: conservar, borradas: borrar }, null, 2));
    console.log(`\n  respaldo escrito en ${dump}`);

    if (!apply) {
      console.log("\n  DRY-RUN: no se borró nada. Correr con APPLY=true para aplicar.\n");
      return;
    }

    const ids = borrar.map((r) => r.id);
    await db.query("BEGIN");
    const del = await db.query(`DELETE FROM pos_credit_memo_item WHERE id = ANY($1::text[])`, [ids]);
    if (del.rowCount !== ESPERADAS_POR_TANDA) {
      await db.query("ROLLBACK");
      console.error(`\n❌ El DELETE afectó ${del.rowCount} filas y se esperaban ${ESPERADAS_POR_TANDA}. ROLLBACK.`);
      process.exit(1);
    }
    // Verificar DENTRO de la transacción: si no cuadra, se revierte.
    const post = await db.query<{ sub: string; lineas: string }>(
      `SELECT cm.subtotal::text AS sub, SUM(cmi.line_total)::text AS lineas
       FROM pos_credit_memo cm
       JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
       WHERE cm.credit_memo_number = $1
       GROUP BY cm.subtotal`,
      [MEMO]
    );
    const { sub, lineas } = post.rows[0] ?? { sub: "?", lineas: "?" };
    if (sub !== lineas) {
      await db.query("ROLLBACK");
      console.error(`\n❌ Tras el borrado subtotal=${sub} y líneas=${lineas}. No cuadra: ROLLBACK.`);
      process.exit(1);
    }
    await db.query("COMMIT");
    console.log(`\n✅ ${del.rowCount} filas borradas. ${MEMO} cuadra: subtotal ${sub} = líneas ${lineas}.\n`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error("❌ repair explotó:", e);
  process.exit(1);
});
