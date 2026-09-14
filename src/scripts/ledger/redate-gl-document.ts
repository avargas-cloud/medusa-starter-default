/**
 * redate-gl-document — mueve de fecha UN documento posteado del libro (GL), append-only:
 * reversa el asiento activo EN su día original y postea el mismo documento (mismas líneas,
 * mismas cuentas, mismos montos) en el día nuevo. El neto por período es el único cambio:
 * el gasto sale del mes donde estaba y entra al mes del banco.
 *
 * Caso que lo motivó (conciliación Chase 7223, 2026-09-14): QB fecha el débito mensual de
 * OscarHealth el día 1 del mes de cobertura (07-01) y el banco lo paga el último día del mes
 * anterior (06-30). El extracto de junio no puede casar un asiento del 1 de julio (el libro de
 * un extracto termina en su `to`), así que junio no cierra hasta que el asiento viva en junio.
 *
 *   ECOPOWERTECH_ENV=… DATABASE_URL=… ./node_modules/.bin/tsx \
 *     src/scripts/ledger/redate-gl-document.ts --source qb_import:1C8E6D-1782909720 --day 2026-06-30 \
 *     --reason "banco 06-30 (Chase 7223 jun)" [--actor a.vargas@ecopowertech.com] [--apply]
 *
 * DRY-RUN por default: muestra el asiento activo, sus líneas y qué haría. `--apply` escribe.
 * Se puede pasar `--source` varias veces (todos al mismo `--day`) o un `--entry bje_…`.
 * Idempotente por construcción: si el documento ya vive en `--day`, no hace nada; si ya fue
 * reversado (sin repost), postea el repost.
 */
import { getDbPool } from "../../api/utils/db-pool";
import {
  activeDocumentEntry,
  postDocumentJournal,
  reverseDocumentJournal,
} from "../../lib/ledger/post";
import type { LedgerAccount, LedgerLine, PostDocumentInput } from "../../lib/ledger/types";

type Target = { source_kind: PostDocumentInput["source_kind"]; source_id: string };

function parseArgs(argv: string[]): {
  targets: Target[];
  day: string;
  reason: string;
  actor: string;
  apply: boolean;
} {
  const values = (flag: string): string[] =>
    argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
  const day = values("--day")[0];
  const reason = values("--reason")[0];
  const targets: Target[] = values("--source").map((s) => {
    const i = s.indexOf(":");
    if (i <= 0) throw new Error(`--source espera kind:id, recibió ${s}`);
    return { source_kind: s.slice(0, i) as PostDocumentInput["source_kind"], source_id: s.slice(i + 1) };
  });
  const entries = values("--entry");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--day YYYY-MM-DD es obligatorio");
  if (!reason) throw new Error("--reason es obligatorio (queda en el asiento de reversa)");
  if (!targets.length && !entries.length) throw new Error("falta --source kind:id o --entry bje_…");
  return {
    targets: [...targets, ...entries.map((e) => ({ source_kind: "__entry__" as PostDocumentInput["source_kind"], source_id: e }))],
    day,
    reason,
    actor: values("--actor")[0] ?? "a.vargas@ecopowertech.com",
    apply: argv.includes("--apply"),
  };
}

const money = (c: number | string): string =>
  (Number(c) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = getDbPool();
  const actorRow = (
    await pool.query<{ id: string }>(
      `SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`,
      [args.actor]
    )
  ).rows[0];
  if (!actorRow) throw new Error(`actor no encontrado: ${args.actor}`);

  // --entry → (source_kind, source_id) del asiento; el resto ya viene resuelto.
  const targets: Target[] = [];
  for (const t of args.targets) {
    if (t.source_kind !== "__entry__") {
      targets.push(t);
      continue;
    }
    const row = (
      await pool.query<{ source_kind: string; source_id: string }>(
        `SELECT source_kind,source_id FROM bank_journal_entry WHERE id=$1 AND kind='document' AND source_kind IS NOT NULL`,
        [t.source_id]
      )
    ).rows[0];
    if (!row) throw new Error(`--entry ${t.source_id}: no es un documento del GL`);
    targets.push({ source_kind: row.source_kind as PostDocumentInput["source_kind"], source_id: row.source_id });
  }

  const client = await pool.connect();
  try {
    for (const target of targets) {
      const active = await activeDocumentEntry(client, target.source_kind, target.source_id);
      // Último documento (activo o ya reversado sin repost): de ahí salen las líneas a repostear.
      const last = (
        await client.query<{
          id: string;
          day: string;
          document_number: string | null;
          reference: string;
          description: string;
          source_snapshot: Record<string, unknown>;
          reversed_by: string | null;
        }>(
          `SELECT e.id,e.day,e.document_number,e.reference,e.description,e.source_snapshot,
                  (SELECT r.id FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id) AS reversed_by
             FROM bank_journal_entry e
            WHERE e.source_kind=$1 AND e.source_id=$2 AND e.kind='document'
            ORDER BY e.created_at DESC LIMIT 1`,
          [target.source_kind, target.source_id]
        )
      ).rows[0];
      if (!last) throw new Error(`${target.source_kind}:${target.source_id}: sin asiento`);
      const lines = (
        await client.query<{ role: string; account_snapshot: LedgerAccount; debit_cents: string; credit_cents: string }>(
          `SELECT role,account_snapshot,debit_cents::text,credit_cents::text FROM bank_journal_line WHERE entry_id=$1 ORDER BY role`,
          [last.id]
        )
      ).rows;
      console.log(`\n${target.source_kind}:${target.source_id} · ${last.reference}`);
      console.log(`  asiento ${last.id} · día ${last.day}${active ? " (activo)" : ` (ya reversado por ${last.reversed_by})`} · ${lines.length} líneas`);
      for (const l of lines)
        console.log(`    ${l.role}  ${(l.account_snapshot.name ?? l.account_snapshot.id).padEnd(45)} D ${money(l.debit_cents).padStart(12)}  C ${money(l.credit_cents).padStart(12)}`);
      if (active && active.day === args.day) {
        console.log(`  ya vive en ${args.day}: nada que hacer`);
        continue;
      }
      console.log(`  → ${active ? `reversa fechada ${last.day} + ` : ""}repost fechado ${args.day}`);
      if (!args.apply) continue;

      if (active) {
        const rev = await reverseDocumentJournal(client, {
          source_kind: target.source_kind,
          source_id: target.source_id,
          day: last.day,
          reason: `redate-gl-document → ${args.day}: ${args.reason}`,
          actor_id: actorRow.id,
        });
        console.log(`  reversa: ${rev.status}${"entry_id" in rev ? ` ${rev.entry_id}` : ""}`);
        if (rev.status !== "reversed") throw new Error(`reversa inesperada: ${rev.status}`);
      }
      const ledgerLines: LedgerLine[] = lines.map((l) => ({
        role: l.role,
        account: l.account_snapshot,
        debit_cents: BigInt(l.debit_cents),
        credit_cents: BigInt(l.credit_cents),
      }));
      const snapshot = {
        ...last.source_snapshot,
        date: args.day,
        redated: { from_day: last.day, from_entry_id: last.id, reason: args.reason },
      };
      const { createHash } = await import("node:crypto");
      const posted = await postDocumentJournal(client, {
        source_kind: target.source_kind,
        source_id: target.source_id,
        document_number: last.document_number ?? `${target.source_kind} ${target.source_id}`,
        day: args.day,
        reference: last.reference,
        description: last.description,
        lines: ledgerLines,
        source_snapshot: snapshot,
        source_hash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
        actor_id: actorRow.id,
      });
      console.log(`  repost: ${posted.status}${"entry_id" in posted ? ` ${posted.entry_id}` : ""}`);
      if (posted.status !== "posted") throw new Error(`repost inesperado: ${posted.status}`);
    }
  } finally {
    client.release();
  }
  if (!args.apply) console.log("\nDRY-RUN: no se escribió nada. Usá --apply.");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("redate-gl-document:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
