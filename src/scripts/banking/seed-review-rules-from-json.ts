/**
 * seed-review-rules-from-json — siembra las reglas regex→cuenta de `docs/<tarjeta>-rules-2026.json`
 * (las de `bulk-card-charges`) como reglas del PRODUCTO (`bank_review_rule`, pantalla Rules del
 * POS), que el sync aplica a cada línea nueva como review DRAFT `origin='rule'` — o sea, como
 * SUGERENCIA de categoría que el contador confirma (plan bank-feed-suggestions-20260915).
 *
 *   … ./node_modules/.bin/tsx src/scripts/banking/seed-review-rules-from-json.ts --mask 7704 --rules ../docs/visa7704-rules-2026.json [--apply]
 *
 * DRY-RUN por default: lista las reglas a crear con su cobertura sobre el feed 2026 de la cuenta
 * (líneas que matchean por merchant y por descripción) y las que ya existen. Diferencias con el
 * JSON: `bank_review_rule` matchea por SUBSTRING normalizado, no regex → cada alternativa `a|b`
 * es una regla; `direction='out'` (los JSON sólo cubren cargos); `match_field='description'`
 * (el `name` del feed), y `merchant` sólo cuando un patrón matchea merchant y NO description.
 * Idempotente por (cuenta, campo, patrón, cuenta contable): las existentes se saltean.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { getDbPool } from "../../api/utils/db-pool";
import { previewReviewRule, saveReviewRule } from "../../lib/banking/review-rules";

type Rules = { _accounts: Record<string, string>; rules: Array<[string, string]> };
function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const normalize = (v: string): string => v.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

async function main(): Promise<void> {
  const mask = arg("--mask"), rulesPath = arg("--rules"), actorEmail = arg("--actor") ?? "a.vargas@ecopowertech.com";
  const apply = process.argv.includes("--apply");
  if (!mask || !rulesPath) throw new Error("usage: --mask <4> --rules file.json [--actor email] [--apply]");
  const json = JSON.parse(readFileSync(rulesPath, "utf8")) as Rules;
  const pool = getDbPool();
  const actor = (await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`, [actorEmail])).rows[0];
  if (!actor) throw new Error(`actor no encontrado: ${actorEmail}`);
  const account = (
    await pool.query<{ id: string; name: string; currency: string | null; review_start_date: string | null }>(
      `SELECT id,name,currency,review_start_date::text AS review_start_date FROM bank_account WHERE mask=$1 AND type IN ('credit','depository') AND is_selected AND deleted_at IS NULL`,
      [mask]
    )
  ).rows[0];
  if (!account) throw new Error(`*${mask}: cuenta no encontrada`);
  if (!account.review_start_date) throw new Error(`*${mask}: sin setup de revisión (las reglas exigen review_start_date)`);
  const names = new Map((await pool.query<{ qb_list_id: string; full_name: string }>(`SELECT qb_list_id,full_name FROM qb_account WHERE qb_list_id=ANY($1::text[]) AND is_active AND deleted_at IS NULL`, [Object.values(json._accounts)])).rows.map((r) => [r.qb_list_id, r.full_name]));
  for (const [k, id] of Object.entries(json._accounts)) if (!names.has(id)) throw new Error(`cuenta ${k}=${id} no existe o está inactiva`);
  const feed = (await pool.query<{ name: string; merchant: string | null }>(`SELECT name,merchant_name AS merchant FROM bank_transaction WHERE account_id=$1 AND status='posted' AND deleted_at IS NULL AND amount::numeric>0 AND transaction_date>='2026-01-01'`, [account.id])).rows;
  const existing = (await pool.query<{ match_field: string; pattern: string; category_list_id: string }>(`SELECT match_field,pattern,category_list_id FROM bank_review_rule WHERE account_id=$1 AND deleted_at IS NULL`, [account.id])).rows;
  const exists = (field: string, pattern: string, category: string): boolean => existing.some((r) => r.match_field === field && normalize(r.pattern) === normalize(pattern) && r.category_list_id === category);
  const planned: Array<{ name: string; field: "description" | "merchant"; pattern: string; category: string; hits: number }> = [];
  let priority = 100;
  for (const [key, regex] of json.rules) {
    const category = json._accounts[key]!;
    for (const alt of regex.split("|").map((p) => p.trim()).filter(Boolean)) {
      if (/[\\^$.*+?()[\]{}]/.test(alt)) {
        // Un patrón con metacaracteres (`dq\b`, `^bp$`) no es un substring: se carga a mano en Rules.
        console.log(`SALTEADA  regex       "${alt}" → ${names.get(category)}  (cargarla a mano en la pantalla Rules)`);
        continue;
      }
      const byDesc = feed.filter((r) => normalize(r.name).includes(normalize(alt))).length;
      const byMerch = feed.filter((r) => normalize(r.merchant ?? "").includes(normalize(alt))).length;
      const onlyMerch = feed.filter((r) => !normalize(r.name).includes(normalize(alt)) && normalize(r.merchant ?? "").includes(normalize(alt))).length;
      const fields: Array<"description" | "merchant"> = onlyMerch > 0 ? ["description", "merchant"] : ["description"];
      for (const field of fields) {
        const hits = field === "description" ? byDesc : byMerch;
        const status = exists(field, alt, category) ? "ya existe" : "crear";
        console.log(`${status.padEnd(9)} ${field.padEnd(11)} "${alt}" → ${names.get(category)}  (${hits} líneas 2026)`);
        if (status === "crear") planned.push({ name: `${key}: ${alt}`, field, pattern: alt, category, hits });
      }
    }
  }
  console.log(`\n${account.name} *${mask}: ${planned.length} reglas a crear, ${existing.length} existentes`);
  if (!apply) { console.log("DRY-RUN: no se escribió nada. Usá --apply."); return; }
  for (const p of planned) {
    const input = {
      name: p.name.slice(0, 120), account_id: account.id, active: true, priority: priority++, match_field: p.field, pattern: p.pattern.slice(0, 200),
      direction: "out" as const, currency: (account.currency ?? "USD").toUpperCase(), category_list_id: p.category, counterparty_type: null, counterparty_id: null,
    };
    const preview = await previewReviewRule(actor.id, input);
    const saved = await saveReviewRule(actor.id, `seed-rule:${createHash("sha256").update([account.id, p.field, normalize(p.pattern), p.category].join("|")).digest("hex").slice(0, 32)}`, { ...input, preview_hash: preview.preview_hash });
    console.log(`creada ${(saved as { rule?: { id?: string } }).rule?.id ?? "?"}  "${p.pattern}" → ${names.get(p.category)} · ${preview.affected_count} reviews draft por regla (${preview.skipped_closed} en días cerrados, ${preview.skipped_manual} manuales)`);
  }
}

main().then(() => process.exit(0)).catch((e: unknown) => { console.error("seed-review-rules-from-json:", e instanceof Error ? e.message : e); process.exit(1); });
