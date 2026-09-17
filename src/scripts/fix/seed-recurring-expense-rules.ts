/**
 * src/scripts/fix/seed-recurring-expense-rules.ts — calendar-rules-seed-20260917
 *
 * Carga las reglas del Accounting Calendar que salieron de la auditoría del
 * historial 2026 (987 checks/expenses/card charges, 229 bills, feed de Plaid):
 * gastos con ≥5 meses de cadencia, monto FIJO (desviación ~0) o ESTIMADO (el
 * contador corrige al abrir el documento), contratistas quincenales como DOS
 * reglas por persona (día 15 + último día) y pagos de tarjeta/línea como
 * `transfer`; la cuenta pagadora es la de los ÚLTIMOS pagos (desde julio los
 * contratistas salen de TD 9209). Después materializa desde el 1° del mes y ADOPTA los
 * documentos ya cargados que sean inequívocamente cada ocurrencia.
 *
 * Dry-run por default: imprime la tabla resuelta (ids reales) y el reporte de
 * adopción SIN escribir. `APPLY=true` escribe en UNA transacción. Idempotente
 * por nombre de regla (una regla que ya existe se saltea). Todo payee/cuenta se
 * resuelve contra la base y un faltante ABORTA antes de escribir nada.
 *
 *   env DATABASE_URL=... npx medusa exec ./src/scripts/fix/seed-recurring-expense-rules.ts
 *   env DATABASE_URL=... APPLY=true npx medusa exec ./src/scripts/fix/seed-recurring-expense-rules.ts
 *
 * Reversa: DELETE FROM recurring_expense_rule WHERE created_by_user_id = 'seed:calendar-audit-20260917'
 * (cascade a ocurrencias; los documentos adoptados sólo pierden el enlace).
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { adoptExistingDocuments } from "../../lib/calendar/occurrence-adopt";
import { addDays } from "../../lib/calendar/recurring-occurrences";
import {
  MATERIALIZE_HORIZON_DAYS,
  createRule,
  listRules,
  materializeRule,
  type RawPg,
} from "../../lib/calendar/recurring-repo";
import { parseRecurringRule, type RecurringRuleInput } from "../../lib/calendar/recurring-types";
import { getBusinessDateString } from "../../lib/date/et";

export const SEED_ACTOR = "seed:calendar-audit-20260917";

type Kind = "check" | "expense" | "bill" | "transfer";
type Payee =
  | { type: "vendor"; id: string; name: string }
  | { type: "other"; name: string }
  | { type: "other_name"; id: string; name: string };

/** Una fila de la auditoría. Cuentas por `full_name` de QuickBooks; se resuelven a ListID. */
interface SeedRule {
  name: string;
  kind: Kind;
  payee: Payee | null;
  /** Cuenta de gasto — o la cuenta DESTINO cuando `kind = transfer`. */
  account: string;
  /** Cuenta pagadora (Bank / CreditCard) — el ORIGEN cuando `kind = transfer`. */
  payFrom: string;
  cents: number;
  amount: "fixed" | "estimated";
  day: number;
  notes?: string;
}

const v = (id: string, name: string): Payee => ({ type: "vendor", id, name });
const other = (name: string): Payee => ({ type: "other", name });

const TD = "TD Bank Checking 9209";
const REGIONS = "Regions Bank Checking 1416";
const CHASE = "Chase Bank Checking 7223";
const WELLS = "Wells Fargo Checking 1221";
const AMEX = "American Express";
const VISA_REGIONS = "Visa Regions Bank 4041-2084";
const VISA_CHASE = "Visa Chase Bank 7704";

const QVH = v("qbvnd_01KPGGS62N245WQ1C55ENHXWPR", "The Q.V.H. Corp.");
const TD_BANK = v("qbvnd_01KPGGS3EFT96WYEGZ90Q276AV", "TD Bank");
const ATT = v("qbvnd_01KPGGNA4WP4VAXJAR9QCX9KJE", "ATT");
const WELLS_ON: Payee = { type: "other_name", id: "qbon_01M2NPQ9Y10DJT8KH3G41D90CW", name: "Wells Fargo Bank" };

// ── A · monto FIJO ───────────────────────────────────────────────────────────
const FIXED: SeedRule[] = [
  { name: "Rent — Unit #4 (Q.V.H.)", kind: "check", payee: QVH, account: "Rent Expense:Unit #4", payFrom: TD, cents: 230000, amount: "fixed", day: 2 },
  { name: "Rent — Unit #5 (Q.V.H.)", kind: "check", payee: QVH, account: "Rent Expense:Unit #5", payFrom: TD, cents: 230000, amount: "fixed", day: 2 },
  { name: "Dade County FCU — loan 448727", kind: "check", payee: v("qbvnd_01KPGGNXWFX3S4YZMSW9VBNDV4", "Dade County Federal Credit Union"), account: "Dade County Federal 448727", payFrom: TD, cents: 78271, amount: "fixed", day: 16 },
  { name: "SBA EIDL", kind: "check", payee: other("SBA EIDL"), account: "Interest Expense:SBA Loan", payFrom: TD, cents: 73100, amount: "fixed", day: 19 },
  { name: "Westlake Financial", kind: "check", payee: v("qbvnd_01KPGGSMQ16WQXG46J70K69SAH", "Westlake Financial"), account: "Management Consulting Service:President", payFrom: REGIONS, cents: 29961, amount: "fixed", day: 17 },
  { name: "Capital One", kind: "check", payee: v("qbvnd_01KPGGNKDXN2B47KR9MCAAPKDF", "Capital One"), account: "Management Consulting Service:Vice President", payFrom: TD, cents: 43531, amount: "fixed", day: 24 },
  { name: "Oscar Health", kind: "check", payee: v("qbvnd_01KY8HFQBATCRAFYVQ8QW2BZD7", "Oscar Health Insurance"), account: "Management Consulting Service:President", payFrom: CHASE, cents: 21506, amount: "fixed", day: 31, notes: "Historial: se reparte President + Vice President; la regla abre una línea, repartir al guardar" },
  { name: "SunPass", kind: "check", payee: v("qbvnd_01KPGGRZTJDWMJG6H0552643DV", "SunPass Florida"), account: "Automobile Expense:Tolls & Parking", payFrom: REGIONS, cents: 1000, amount: "fixed", day: 1 },
  { name: "AT&T — landline", kind: "check", payee: ATT, account: "Telephone Expense:AT&T Services", payFrom: REGIONS, cents: 13910, amount: "fixed", day: 2 },
  { name: "Ascendant — general liability", kind: "check", payee: v("qbvnd_01KPGGN94E72RFQ48968RPF0EM", "Ascendant Commercial Insurance Inc."), account: "Insurance Expense:General Liability Insurance", payFrom: TD, cents: 11899, amount: "fixed", day: 6 },
  { name: "The One Percent", kind: "expense", payee: other("The One Percent"), account: "Dues and Subscriptions", payFrom: AMEX, cents: 9900, amount: "fixed", day: 5 },
  { name: "OpenAI", kind: "expense", payee: other("OpenAI"), account: "Dues and Subscriptions", payFrom: AMEX, cents: 10000, amount: "fixed", day: 4 },
  { name: "Shutterstock", kind: "expense", payee: other("Shutterstock"), account: "Dues and Subscriptions", payFrom: AMEX, cents: 5900, amount: "fixed", day: 20 },
  { name: "SimpliSafe", kind: "expense", payee: other("SimpliSafe"), account: "Dues and Subscriptions", payFrom: AMEX, cents: 3744, amount: "fixed", day: 18 },
  { name: "Mailchimp", kind: "expense", payee: other("Mailchimp"), account: "Dues and Subscriptions", payFrom: AMEX, cents: 2650, amount: "fixed", day: 30 },
  { name: "GoDaddy", kind: "expense", payee: other("GoDaddy"), account: "Dues and Subscriptions", payFrom: AMEX, cents: 2319, amount: "fixed", day: 5 },
  { name: "ClickUp", kind: "expense", payee: v("qbvnd_01KPGGNS803967N84ZQH46HMRB", "ClickUp San Diego"), account: "Business Licenses and Permits", payFrom: VISA_REGIONS, cents: 3000, amount: "fixed", day: 31 },
  { name: "Vercel", kind: "expense", payee: other("Vercel Inc."), account: "Office Supplies", payFrom: VISA_REGIONS, cents: 2000, amount: "fixed", day: 6 },
  { name: "Banahosting", kind: "expense", payee: other("Banahosting"), account: "Dues and Subscriptions", payFrom: VISA_CHASE, cents: 695, amount: "fixed", day: 10, notes: "Sólo visto en el feed de la 7704; nunca se cargó en el libro" },
  { name: "Wells Fargo — monthly service fee", kind: "expense", payee: WELLS_ON, account: "Bank Service Charges:Fees", payFrom: WELLS, cents: 1500, amount: "fixed", day: 31 },
];

// ── B · monto ESTIMADO (último valor; el contador lo corrige) ────────────────
const ESTIMATED: SeedRule[] = [
  { name: "FPL — Unit #4", kind: "check", payee: v("qbvnd_01KPGGPHJ9DFWESFT24SMPDR3Y", "FPL"), account: "Utilities:FPL:Unit #4", payFrom: CHASE, cents: 56453, amount: "estimated", day: 2 },
  { name: "FPL — Unit #5", kind: "check", payee: v("qbvnd_01KPGGPHJ9DFWESFT24SMPDR3Y", "FPL"), account: "Utilities:FPL:Unit #5", payFrom: CHASE, cents: 48800, amount: "estimated", day: 2 },
  { name: "AT&T — services", kind: "check", payee: ATT, account: "Telephone Expense", payFrom: REGIONS, cents: 66500, amount: "estimated", day: 14 },
  { name: "Ring Central", kind: "expense", payee: v("qbvnd_01KPGGRG0EN05M90KRXQ1SBKZW", "Ring Central"), account: "Telephone Expense:Ring Central", payFrom: VISA_CHASE, cents: 12000, amount: "estimated", day: 5 },
  { name: "GEICO — auto", kind: "check", payee: v("qbvnd_01KPGGPN1RM965KAVHPTM5FJ4E", "GEICO Auto"), account: "Insurance Expense:Auto Insurance", payFrom: REGIONS, cents: 23817, amount: "estimated", day: 6 },
  { name: "Fundation — credit line (Quantum SPV)", kind: "check", payee: v("qbvnd_01KPGGPKEKMRH1KNYDRMMWPS29", "Fundation"), account: "Loans Payable:Credit Line Fundation:Principal", payFrom: REGIONS, cents: 619616, amount: "estimated", day: 5, notes: "Principal + interés en el mismo pago; repartir al guardar" },
  { name: "TD Bank — line of credit interest", kind: "check", payee: TD_BANK, account: "Interest Expense:Line of Credit TD Bank", payFrom: TD, cents: 207800, amount: "estimated", day: 10 },
  { name: "Chase — credit line payment", kind: "check", payee: other("Chase Bank"), account: "Loans Payable:Chase Credit Line:Principal", payFrom: CHASE, cents: 131023, amount: "estimated", day: 10 },
  { name: "Visa Chase 7704 — interest", kind: "expense", payee: other("Chase Bank"), account: "Interest Expense:Chase Bank", payFrom: VISA_CHASE, cents: 10200, amount: "estimated", day: 10 },
  { name: "Visa Regions 2084 — interest", kind: "expense", payee: v("qbvnd_01KPGGREPTY9N33VEK5TE2D811", "Regions Bank"), account: "Interest Expense:Regions Bank", payFrom: VISA_REGIONS, cents: 60000, amount: "estimated", day: 15 },
  { name: "Amerant — interest", kind: "check", payee: other("Amerant Bank"), account: "Interest Expense:Amerant Bank", payFrom: TD, cents: 35700, amount: "estimated", day: 17 },
  { name: "TD Bank — merchant fee A", kind: "expense", payee: TD_BANK, account: "Merchant Acct Fees", payFrom: TD, cents: 4495, amount: "fixed", day: 3, notes: "Dos cargos el mismo día (44.95 y 34.95): una regla por cargo" },
  { name: "TD Bank — merchant fee B", kind: "expense", payee: TD_BANK, account: "Merchant Acct Fees", payFrom: TD, cents: 3495, amount: "fixed", day: 3, notes: "Dos cargos el mismo día (44.95 y 34.95): una regla por cargo" },
  { name: "Wells Fargo — merchant fee", kind: "expense", payee: WELLS_ON, account: "Merchant Acct Fees", payFrom: WELLS, cents: 2000, amount: "estimated", day: 2 },
  { name: "Shippo", kind: "expense", payee: v("qbvnd_01KPGGRRW5KTDCR9R71F4CP6GY", "Shippo"), account: "Freight and Shipping Costs:Shippo", payFrom: VISA_CHASE, cents: 4100, amount: "estimated", day: 20 },
];

// ── C · contratistas quincenales (día 15 + último día = dos reglas) ──────────
const CONTRACTORS: Array<Omit<SeedRule, "day" | "kind">> = [
  { name: "Jannett C. Peralta Q.", payee: v("qbvnd_01KPGGQ1Z6VEHGK9XHJXD6DJFY", "Jannett C. Peralta Q."), account: "Management Consulting Service:Vice President", payFrom: TD, cents: 225000, amount: "fixed" },
  { name: "Jose T. Vargas Martinez", payee: v("qbvnd_01KPGGQ50JFFEDJ2H7ZCH3FF53", "Jose T. Vargas Martinez"), account: "Management Consulting Service:President", payFrom: TD, cents: 225000, amount: "fixed" },
  { name: "Alejandro Vargas P.", payee: v("qbvnd_01KPGGN20NWF0567TYD98AQ57S", "Alejandro Vargas P"), account: "Management Consulting Service:Project Manager", payFrom: TD, cents: 225000, amount: "fixed" },
  { name: "Evelyn Coots", payee: v("qbvnd_01KPGGPBGY5TSP9AMZCFQBSHPY", "Evelyn Coots"), account: "Consulting Services", payFrom: TD, cents: 150000, amount: "fixed" },
  { name: "Ana Guedez", payee: v("qbvnd_01KPGGN6BZDP76473043QQT2CJ", "Ana Guedez"), account: "Consulting Services", payFrom: TD, cents: 172600, amount: "estimated" },
  { name: "Angel A. Arenas", payee: v("qbvnd_01KPGGN77VCHY9C7KET7A7H51B", "Angel A Arenas"), account: "Consulting Services", payFrom: TD, cents: 213194, amount: "estimated" },
  { name: "Maria F. Perez", payee: v("qbvnd_01KPGGQNH72DHYXWD7T8AP8ZW0", "Maria F Perez"), account: "Consulting Services", payFrom: TD, cents: 139400, amount: "estimated" },
];

// ── D · transfers: pago de tarjeta / línea (origen → destino) ────────────────
const TRANSFERS: SeedRule[] = [
  { name: "Amex — card payment", kind: "transfer", payee: null, account: AMEX, payFrom: TD, cents: 140000, amount: "estimated", day: 17 },
  { name: "Visa Regions 2084 — card payment", kind: "transfer", payee: null, account: VISA_REGIONS, payFrom: REGIONS, cents: 161456, amount: "estimated", day: 10 },
  { name: "Home Depot card — payment", kind: "transfer", payee: null, account: "The Home Depot 9452", payFrom: REGIONS, cents: 5000, amount: "fixed", day: 15 },
  { name: "Visa Chase 7704 — card payment", kind: "transfer", payee: null, account: VISA_CHASE, payFrom: CHASE, cents: 9000, amount: "estimated", day: 4 },
];

export function seedRules(): SeedRule[] {
  const contractors = CONTRACTORS.flatMap((c) => [
    { ...c, kind: "check" as const, day: 15, name: `${c.name} — 15th` },
    { ...c, kind: "check" as const, day: 31, name: `${c.name} — end of month` },
  ]);
  return [...FIXED, ...ESTIMATED, ...contractors, ...TRANSFERS];
}

type Resolved = { seed: SeedRule; input: RecurringRuleInput };

async function resolveAll(pg: RawPg, todayEt: string): Promise<{ resolved: Resolved[]; problems: string[] }> {
  const accounts = (await pg.raw(`SELECT qb_list_id, full_name, account_type FROM qb_account WHERE is_active AND deleted_at IS NULL`)).rows as Array<{ qb_list_id: string; full_name: string; account_type: string }>;
  const byName = new Map(accounts.map((a) => [a.full_name, a]));
  const vendorIds = new Set(((await pg.raw(`SELECT id FROM qb_vendor WHERE is_active = true AND deleted_at IS NULL`)).rows as Array<{ id: string }>).map((r) => r.id));
  const otherIds = new Set(((await pg.raw(`SELECT id FROM qb_other_name WHERE is_active = true AND deleted_at IS NULL`)).rows as Array<{ id: string }>).map((r) => r.id));
  const problems: string[] = [];
  const resolved: Resolved[] = [];
  for (const seed of seedRules()) {
    const account = byName.get(seed.account);
    const payFrom = byName.get(seed.payFrom);
    if (!account) problems.push(`${seed.name}: cuenta '${seed.account}' no existe`);
    if (!payFrom) problems.push(`${seed.name}: cuenta pagadora '${seed.payFrom}' no existe`);
    if (seed.payee?.type === "vendor" && !vendorIds.has(seed.payee.id)) problems.push(`${seed.name}: vendor ${seed.payee.id} no existe/activo`);
    if (seed.payee?.type === "other_name" && !otherIds.has(seed.payee.id)) problems.push(`${seed.name}: other name ${seed.payee.id} no existe/activo`);
    const parsed = parseRecurringRule({
      name: seed.name,
      frequency: "monthly",
      day_of_month: seed.day,
      end_of_month_policy: "last_day",
      expected_amount_cents: seed.cents,
      amount_kind: seed.amount,
      // Fijo = ±$5 (AT&T 139.10 → 140.40 sigue siendo "el mismo" cargo); estimado = ±25 %.
      tolerance_cents: seed.amount === "fixed" ? 500 : 0,
      tolerance_pct: seed.amount === "estimated" ? 25 : 0,
      start_date: `${todayEt.slice(0, 7)}-01`,
      document_kind: seed.kind,
      payee_type: seed.payee?.type ?? null,
      payee_id: seed.payee && seed.payee.type !== "other" ? seed.payee.id : null,
      payee_name: seed.payee?.name ?? null,
      expense_account_list_id: account?.qb_list_id ?? null,
      pay_from_account_list_id: payFrom?.qb_list_id ?? null,
      notes: seed.notes ?? `Seed ${SEED_ACTOR} — auditoría del historial 2026`,
    });
    if (!parsed.ok) problems.push(`${seed.name}: ${parsed.error}`);
    else resolved.push({ seed, input: parsed.value });
  }
  return { resolved, problems };
}

export default async function seedRecurringExpenseRules({ container }: ExecArgs): Promise<void> {
  const apply = process.env.APPLY === "true";
  const pg = container.resolve("__pg_connection__") as RawPg & { transaction?: () => Promise<RawPg & { commit: () => Promise<void>; rollback: () => Promise<void> }> };
  const today = getBusinessDateString();
  const { resolved, problems } = await resolveAll(pg, today);
  console.log(`\n${apply ? "APPLY" : "DRY-RUN"} · seed-recurring-expense-rules · hoy ${today} · ${resolved.length} reglas resueltas`);
  if (problems.length) {
    console.log(`\n❌ ${problems.length} problema(s) — no se escribe nada:`);
    for (const p of problems) console.log(`   · ${p}`);
    process.exitCode = 1;
    return;
  }
  const existing = new Set((await listRules(pg, true)).map((r) => r.name));
  const fresh = resolved.filter((r) => !existing.has(r.input.name));
  console.log(`   ${existing.size} regla(s) ya en la base · ${fresh.length} por crear\n`);
  for (const r of fresh) {
    console.log(`   ${r.input.document_kind.padEnd(8)} d${String(r.input.day_of_month).padStart(2)}  $${(r.input.expected_amount_cents / 100).toFixed(2).padStart(9)} ${r.input.amount_kind.padEnd(9)} ${r.input.name}`);
  }
  if (!apply) {
    console.log(`\n(dry-run) La adopción se evalúa sólo con las reglas creadas — correr con APPLY=true para ver el enlace real.`);
    return;
  }
  const trx = pg.transaction ? await pg.transaction() : null;
  const db = trx ?? pg;
  try {
    const horizon = addDays(today, MATERIALIZE_HORIZON_DAYS);
    let inserted = 0;
    for (const r of fresh) {
      const rule = await createRule(db, r.input, SEED_ACTOR);
      inserted += await materializeRule(db, rule, `${today.slice(0, 7)}-01`, horizon);
    }
    const adopt = await adoptExistingDocuments(db, `${today.slice(0, 7)}-01`, horizon, { actorId: SEED_ACTOR });
    if (trx) await trx.commit();
    console.log(`\n✅ ${fresh.length} regla(s) creadas · ${inserted} ocurrencia(s) materializadas · ${adopt.adopted.length} adoptada(s) · ${adopt.ambiguous.length} ambigua(s) de ${adopt.scanned}`);
    for (const a of adopt.adopted) console.log(`   ✔ ${a.due_date} ${a.rule_name} → ${a.document.doc_number} (${a.document.day}, $${(a.document.total_cents / 100).toFixed(2)})`);
    for (const a of adopt.ambiguous) console.log(`   ? ${a.due_date} ${a.rule_name}: ${a.candidates.map((c) => `${c.doc_number} ${c.day} $${(c.total_cents / 100).toFixed(2)}`).join(" | ")}`);
  } catch (error) {
    if (trx) await trx.rollback();
    throw error;
  }
}
