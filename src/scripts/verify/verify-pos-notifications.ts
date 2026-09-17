/**
 * verify-pos-notifications.ts — gate de la bandeja de notificaciones del POS.
 *
 *   env DATABASE_URL=<sandbox> POS_OWNER_EMAILS=<owner del sandbox> \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-pos-notifications.ts
 *
 * §1 estático — las rutas toman el destinatario del JWT y de ningún parámetro.
 * §2 estático — un solo camino de escritura (`publishNotification`, ON CONFLICT);
 *               ningún productor importa código de dinero ni de QB.
 * §3 puro     — helpers sin DB (limit, fingerprint, guard de las 7 am, audiencias).
 * §4 DB       — transacción con ROLLBACK: dedupe, privacidad de la bandeja,
 *               rep WEB en orden web (nunca en una POS), PO de hoy, fila QB.
 *
 * Mutation-tested (09/17/2026): §1 con una ruta que lee `req.query.user_id`;
 * §2 con un INSERT directo en un productor. Las dos ramas ponen rojo.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

import { Client } from "pg";

import { clampLimit, countUnread, listInbox, markAllRead, markRead } from "../../lib/notifications/inbox";
import { buildPaymentNotification, producePaymentNotifications } from "../../lib/notifications/producers/payments";
import { businessHour, isPoDueHour, producePoDueToday } from "../../lib/notifications/producers/po-due-today";
import { errorFingerprint, produceQbFailureNotifications, qbFailureDedupeKey } from "../../lib/notifications/producers/qb-failures";
import { produceWebOrderPlaced, WEB_SALES_REP } from "../../lib/notifications/producers/web-order";
import { publishNotification, resolveNotificationsByEntity } from "../../lib/notifications/publish";
import { resolveRecipients } from "../../lib/notifications/recipients";

const ROOT = resolve(__dirname, "../../..");
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Líneas de código sin imports ni comentarios: "llama a X" no se acredita con un import. */
function codeLines(src: string): string[] {
  return src
    .split("\n")
    .filter((l) => !/^\s*(import|export \{|\/\/|\*|\/\*)/.test(l));
}

// ─── §1 rutas ────────────────────────────────────────────────────────────────
function section1(): void {
  console.log("§1 rutas: el destinatario sale del JWT");
  const routes = [
    "src/api/admin/pos/notifications/route.ts",
    "src/api/admin/pos/notifications/[id]/read/route.ts",
    "src/api/admin/pos/notifications/read-all/route.ts",
  ];
  for (const rel of routes) {
    const src = read(rel);
    const body = codeLines(src).join("\n");
    check(`${rel}: usa req.auth_context.actor_id`, /req\.auth_context\?\.actor_id/.test(body));
    // LEER `.user_id` / `["user_id"]` de cualquier objeto está prohibido: el
    // único user_id legítimo es el que la ruta PASA (`{ user_id: userId }`).
    // Un regex atado a `req.query.user_id` no cazó `(req.query as X).user_id`
    // (mutation test 09/17); éste mira el acceso, no el receptor.
    check(`${rel}: no LEE user_id de ningún objeto (el actor es el JWT)`, !/[.[]\s*["']?user_id/.test(body));
    check(`${rel}: 401 sin actor`, /status\(401\)/.test(body));
  }
}

// ─── §2 un solo camino de escritura ──────────────────────────────────────────
function section2(): void {
  console.log("\n§2 escritura única y sin código de dinero");
  const publish = codeLines(read("src/lib/notifications/publish.ts")).join("\n");
  check("publish.ts: INSERT … ON CONFLICT (dedupe_key) DO NOTHING", /ON CONFLICT \(dedupe_key\) DO NOTHING/.test(publish));

  const producerFiles = [
    ...walk(join(ROOT, "src/lib/notifications/producers")),
    join(ROOT, "src/jobs/pos-notifications-payments.ts"),
    join(ROOT, "src/jobs/pos-notifications-po-due-today.ts"),
    join(ROOT, "src/jobs/pos-notifications-qb-failures.ts"),
    join(ROOT, "src/subscribers/web-order-placed-notify.ts"),
  ];
  check("hay productores que auditar", producerFiles.length >= 8, `${producerFiles.length}`);
  for (const file of producerFiles) {
    const rel = file.slice(ROOT.length + 1);
    const src = readFileSync(file, "utf8");
    const body = codeLines(src).join("\n");
    check(`${rel}: sin INSERT directo en pos_notification`, !/INSERT\s+INTO\s+pos_notification/i.test(body));
    check(
      `${rel}: no importa quickbooks / invoices / finance / calendar`,
      !/from\s+["'][^"']*(lib\/quickbooks|api\/admin\/invoices|api\/admin\/finance|lib\/calendar)/.test(src)
    );
    const isPure = /producers\/format\.ts$/.test(rel);
    if (!isPure) {
      const producesViaPublish = /publishNotification\(/.test(body);
      const delegates = /produce(PaymentNotifications|PoDueToday|QbFailureNotifications|WebOrderPlaced)\(/.test(body);
      check(`${rel}: publica vía publishNotification o delega a un productor`, producesViaPublish || delegates);
    }
  }
  for (const job of ["pos-notifications-payments", "pos-notifications-po-due-today", "pos-notifications-qb-failures"]) {
    const body = codeLines(read(`src/jobs/${job}.ts`)).join("\n");
    check(`${job}: respeta isScheduledJobsDisabled`, /isScheduledJobsDisabled\(container\)/.test(body));
  }
  const webOrder = read("src/lib/notifications/producers/web-order.ts");
  check(
    "web-order: el UPDATE de metadata sólo pisa órdenes web sin rep",
    /pos_created[^\n]*<> 'true'/.test(webOrder) && /sales_rep'->>'initials'\), ''\) = ''/.test(webOrder)
  );
}

// ─── §3 puro ─────────────────────────────────────────────────────────────────
function section3(): void {
  console.log("\n§3 helpers puros");
  check("clampLimit: default 30", clampLimit(undefined) === 30);
  check("clampLimit: tope 100", clampLimit("5000") === 100);
  check("clampLimit: basura → default", clampLimit("abc") === 30 && clampLimit("-3") === 30);
  check("errorFingerprint: estable y corto", errorFingerprint(" x ") === errorFingerprint("x") && errorFingerprint("x").length === 12);
  check("qbFailureDedupeKey cambia con el error", qbFailureDedupeKey("r1", "a") !== qbFailureDedupeKey("r1", "b"));

  // 7 am ET (EDT, UTC-4) = 11:00Z; 8 am ET = 12:00Z. En EST sería 12:00Z, por
  // eso las fechas son de septiembre (EDT) y se afirma también el borde 06:59.
  check("isPoDueHour: 07:00 ET → true", isPoDueHour(new Date("2026-09-17T11:00:00Z")));
  check("isPoDueHour: 07:59 ET → true", isPoDueHour(new Date("2026-09-17T11:59:00Z")));
  check("isPoDueHour: 06:59 ET → false", !isPoDueHour(new Date("2026-09-17T10:59:00Z")));
  check("isPoDueHour: 08:00 ET → false", !isPoDueHour(new Date("2026-09-17T12:00:00Z")));
  check("businessHour: medianoche ET → 0", businessHour(new Date("2026-09-17T04:00:00Z")) === 0);

  const built = buildPaymentNotification({
    id: "papp_1", payment_id: "cp_1", invoice_id: "inv_1", invoice_number: "21999", order_id: "ord_1",
    amount_applied: "12345", applied_at: null, method: "credit_card", payment_display_id: 7,
    order_display_id: 9, document_number: "S9", rep_initials: "AG",
    company_name: "ACME", first_name: null, last_name: null, email: null,
  });
  check("pago: título con monto en dólares y método", built.title.includes("$123.45") && built.title.includes("Credit card"));
  check("pago: audiencias admins + rep", built.audiences.some((a) => a.kind === "admins") && built.audiences.some((a) => a.kind === "rep"));
  check("pago: navega a la factura", built.action_url === "/invoices/inv_1");
  check("pago: dedupe por payment_application", built.dedupe_key === "payment_applied:papp_1");
}

// ─── §4 DB ───────────────────────────────────────────────────────────────────
async function section4(): Promise<void> {
  console.log("\n§4 base de datos (transacción con ROLLBACK)");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("⏭️  sin DATABASE_URL — se omite");
    return;
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('pos_notification','pos_notification_recipient')`
    );
    check("tablas migradas", tables.rowCount === 2);
    const uq = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'uq_posn_dedupe'`);
    check("dedupe_key UNIQUE existe", (uq.rowCount ?? 0) === 1);

    // Audiencias
    const all = await resolveRecipients(client, [{ kind: "all" }]);
    const admins = await resolveRecipients(client, [{ kind: "admins" }]);
    const owner = await resolveRecipients(client, [{ kind: "owner" }]);
    check("all ⊇ admins", admins.every((id) => all.includes(id)) && all.length >= admins.length, `all=${all.length} admins=${admins.length}`);
    check("all no incluye la cuenta técnica webhook@", !(await client.query(`SELECT id FROM "user" WHERE lower(email) LIKE 'webhook@%' AND id = ANY($1::text[])`, [all])).rowCount);
    if (process.env.POS_OWNER_EMAILS) {
      check("owner resuelve al menos un usuario", owner.length >= 1, `${owner.length}`);
      check("owner ⊆ admins", owner.every((id) => admins.includes(id)));
    } else {
      check("owner sin POS_OWNER_EMAILS → nadie (falla cerrado)", owner.length === 0);
    }
    const union = await resolveRecipients(client, [{ kind: "admins" }, { kind: "admins" }]);
    check("unión sin duplicados", union.length === admins.length);

    // Dedupe + privacidad
    const key = `verify:${Date.now()}`;
    const target = admins[0] ?? all[0];
    check("hay al menos un usuario para probar", Boolean(target));
    const first = await publishNotification(client, {
      kind: "payment_received", title: "verify", dedupe_key: key, audiences: [{ kind: "users", user_ids: [target] }],
    });
    const second = await publishNotification(client, {
      kind: "payment_received", title: "verify AGAIN", dedupe_key: key, audiences: [{ kind: "users", user_ids: [target] }],
    });
    check("misma dedupe_key → una sola fila", first.created && !second.created);
    const rows = await client.query(`SELECT title FROM pos_notification WHERE dedupe_key = $1`, [key]);
    check("la segunda no pisa la primera", rows.rowCount === 1 && rows.rows[0].title === "verify");

    const mine = await listInbox(client, { user_id: target, unread_only: true, limit: 30 });
    check("el destinatario la ve en unread", mine.some((n) => n.id === first.notification_id));
    const stranger = (await client.query(`SELECT id FROM "user" WHERE deleted_at IS NULL AND id <> ALL($1::text[]) LIMIT 1`, [[target]])).rows[0]?.id as string | undefined;
    if (stranger) {
      const theirs = await listInbox(client, { user_id: stranger, unread_only: false, limit: 100 });
      check("otro usuario NO la ve", !theirs.some((n) => n.id === first.notification_id));
      check("otro usuario no puede marcarla leída", !(await markRead(client, stranger, first.notification_id!)));
    }
    const before = await countUnread(client, target);
    check("markRead propio → true", await markRead(client, target, first.notification_id!));
    check("unread baja en 1", (await countUnread(client, target)) === before - 1);
    await publishNotification(client, {
      kind: "payment_received", title: "verify 2", dedupe_key: `${key}:2`, audiences: [{ kind: "users", user_ids: [target] }],
    });
    check("markAllRead deja 0", (await markAllRead(client, target)) >= 1 && (await countUnread(client, target)) === 0);
    check("resolve por entidad", (await resolveNotificationsByEntity(client, "none", "none")) === 0);

    // Orden web: se simula con una orden POS vuelta web DENTRO de la tx
    const pos = (await client.query(`SELECT id FROM "order" WHERE deleted_at IS NULL AND metadata->>'pos_created' = 'true' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    if (pos) {
      const skipped = await produceWebOrderPlaced(client, pos.id);
      check("orden POS → skipped, sin rep WEB ni aviso", skipped.skipped === "pos_order" && !skipped.rep_assigned && skipped.result === null);
      await client.query(`UPDATE "order" SET metadata = (metadata - 'sales_rep') || '{"pos_created": false}'::jsonb WHERE id = $1`, [pos.id]);
      const web = await produceWebOrderPlaced(client, pos.id);
      const rep = (await client.query(`SELECT metadata->'sales_rep' AS rep FROM "order" WHERE id = $1`, [pos.id])).rows[0]?.rep;
      check("orden web sin rep → rep WEB", web.rep_assigned && rep?.initials === WEB_SALES_REP.initials);
      check("orden web → notificación a TODOS", web.result?.created === true && web.result.recipient_user_ids.length === all.length, `${web.result?.recipient_user_ids.length}/${all.length}`);
      const again = await produceWebOrderPlaced(client, pos.id);
      check("segunda vez: rep intacto y sin aviso nuevo", !again.rep_assigned && again.result?.created === false);
    }

    // PO que llega hoy
    const po = (await client.query(`SELECT id FROM purchase_order WHERE deleted_at IS NULL AND status = 'submitted' LIMIT 1`)).rows[0];
    if (po) {
      await client.query(`UPDATE purchase_order SET expected_at = NOW() WHERE id = $1`, [po.id]);
      // El aviso de HOY puede existir ya (job real / runner): se saca dentro de la tx.
      await client.query(`DELETE FROM pos_notification WHERE dedupe_key LIKE 'po_due_today:%'`);
      const guarded = await producePoDueToday(client, { now: new Date("2026-09-17T12:00:00Z") });
      check("PO due: fuera de las 7 → skipped", guarded.skipped);
      const forced = await producePoDueToday(client, { force: true });
      check("PO due: incluye el PO con expected_at hoy", forced.matched >= 1, `${forced.matched}`);
      const payload = (await client.query(`SELECT payload FROM pos_notification WHERE dedupe_key = $1`, [`po_due_today:${forced.ymd}`])).rows[0]?.payload as { purchase_orders?: { id: string }[] } | undefined;
      check("PO due: el payload lista ese PO", Boolean(payload?.purchase_orders?.some((p) => p.id === po.id)));
      check("PO due: agrupada → destinatarios = admins", forced.result === null || forced.result.created === false || forced.result.recipient_user_ids.length === admins.length);
    }

    // Pago: se recicla una aplicación existente moviéndola a la ventana
    const papp = (await client.query(
      `SELECT pa.id FROM payment_application pa JOIN customer_payment cp ON cp.id = pa.payment_id
        WHERE pa.deleted_at IS NULL AND pa.voided_at IS NULL AND cp.method IN ('cash','credit_card','debit_card') LIMIT 1`
    )).rows[0];
    if (papp) {
      await client.query(`DELETE FROM pos_notification WHERE dedupe_key = $1`, [`payment_applied:${papp.id}`]);
      await client.query(`UPDATE payment_application SET created_at = NOW() WHERE id = $1`, [papp.id]);
      const r1 = await producePaymentNotifications(client, { windowHours: 1 });
      const r2 = await producePaymentNotifications(client, { windowHours: 1 });
      check("pago: 1ª corrida crea, 2ª no", r1.created >= 1 && r2.created === 0, `${r1.created}/${r2.created}`);
    }
    const cm = (await client.query(
      `SELECT pa.id FROM payment_application pa JOIN customer_payment cp ON cp.id = pa.payment_id
        WHERE pa.deleted_at IS NULL AND cp.method = 'credit_memo' LIMIT 1`
    )).rows[0];
    if (cm) {
      await client.query(`UPDATE payment_application SET created_at = NOW() WHERE id = $1`, [cm.id]);
      await producePaymentNotifications(client, { windowHours: 1 });
      const none = await client.query(`SELECT 1 FROM pos_notification WHERE dedupe_key = $1`, [`payment_applied:${cm.id}`]);
      check("pago: un credit memo aplicado NO es dinero recibido", none.rowCount === 0);
    }

    // Fila QB en failed
    const failed = (await client.query(`SELECT id::text AS id, error FROM qb_order_pipeline WHERE status = 'failed' LIMIT 1`)).rows[0];
    if (failed) {
      await client.query(`DELETE FROM pos_notification WHERE dedupe_key LIKE $1`, [`qb_failed:${failed.id}:%`]);
      await client.query(`UPDATE qb_order_pipeline SET failed_at = NOW() WHERE id::text = $1`, [failed.id]);
      const q1 = await produceQbFailureNotifications(client, { windowHours: 1 });
      const q2 = await produceQbFailureNotifications(client, { windowHours: 1 });
      check("QB failed: 1ª corrida crea, 2ª no", q1.created >= 1 && q2.created === 0, `${q1.created}/${q2.created}`);
      await client.query(`UPDATE qb_order_pipeline SET error = COALESCE(error,'') || ' (otro)' WHERE id::text = $1`, [failed.id]);
      const q3 = await produceQbFailureNotifications(client, { windowHours: 1 });
      check("QB failed: error distinto → aviso nuevo", q3.created >= 1);
      const recips = (await client.query(
        `SELECT COUNT(*)::int AS n FROM pos_notification_recipient r JOIN pos_notification n ON n.id = r.notification_id WHERE n.dedupe_key LIKE $1`,
        [`qb_failed:${failed.id}:%`]
      )).rows[0].n as number;
      if (process.env.POS_OWNER_EMAILS) check("QB failed: sólo el owner lo recibe", recips === owner.length * 2, `${recips} vs owner=${owner.length}×2`);
      else check("QB failed sin owner configurado → no nace (falla cerrado)", recips === 0);
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

async function main(): Promise<void> {
  section1();
  section2();
  section3();
  await section4();
  console.log(
    failures.length
      ? `\n❌ ${failures.length} check(s) fallaron: ${failures.join(" · ")}`
      : "\n✅ verify-pos-notifications: todo verde"
  );
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
