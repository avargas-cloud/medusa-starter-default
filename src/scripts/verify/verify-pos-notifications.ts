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
 * §5 fase 2   — recibo → separables (stock forzado a 0 y restaurado en la tx),
 *               pendientes de Accounting, estimates 7 días + semana, resolver
 *               acotado por kind, invitaciones de calendar con fetch inyectado
 *               (Google nunca se llama), ruta rsvp por JWT.
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
import { produceAccountingNotifications } from "../../lib/notifications/producers/accounting";
import { produceCalendarInvites, inviteDedupeKey } from "../../lib/notifications/producers/calendar-invites";
import { AWAITING_STATUSES, buildEstimateNotification, produceStaleEstimates, weekBucket } from "../../lib/notifications/producers/estimates";
import { resolveOrphanNotifications } from "../../lib/notifications/producers/resolver";
import { candidateOrdersForItems, newlySeparable, produceSeparableAfterReceipt, snapshotSeparation, type RawSql } from "../../lib/notifications/producers/separable";
import { pendingInvitationsOf, rsvpPatchBody } from "../../lib/calendar/google-calendar-client";
import { USA_LOC } from "../../lib/locations";

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
    // format.ts es puro; resolver.ts sólo marca resolved_at (UPDATE, jamás INSERT).
    const isPure = /producers\/(format|resolver)\.ts$/.test(rel);
    if (!isPure) {
      const producesViaPublish = /publishNotification\(/.test(body);
      const delegates = /produce(PaymentNotifications|PoDueToday|QbFailureNotifications|WebOrderPlaced|SeparableAfterReceipt|AccountingNotifications|StaleEstimates|CalendarInvites)\(/.test(body);
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
    id: "cp_1", display_id: 7, amount: "12345", method: "credit_card", received_at: null, created_at: "2026-09-17T12:00:00Z",
    invoice_id: "inv_1", invoice_number: "21999", order_id: "ord_1", order_display_id: 9, document_number: "S9", rep_initials: "AG",
    company_name: "ACME", first_name: null, last_name: null, email: null,
  });
  check("pago: título con monto en dólares y método", built.title.includes("$123.45") && built.title.includes("Credit card"));
  check("pago: audiencias admins + rep", built.audiences.some((a) => a.kind === "admins") && built.audiences.some((a) => a.kind === "rep"));
  check("pago: navega a la factura", built.action_url === "/invoices/inv_1");
  check("pago: dedupe por PAGO (linkear un pago viejo no es dinero nuevo)", built.dedupe_key === "payment_received:cp_1" && built.entity_type === "customer_payment");
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

    // Pago: se recicla un PAGO existente moviéndolo a la ventana
    const pay = (await client.query(
      `SELECT id FROM customer_payment WHERE deleted_at IS NULL AND type = 'payment' AND status <> 'voided'
        AND method IN ('cash','credit_card','debit_card') LIMIT 1`
    )).rows[0];
    if (pay) {
      await client.query(`DELETE FROM pos_notification WHERE dedupe_key = $1`, [`payment_received:${pay.id}`]);
      await client.query(`UPDATE customer_payment SET created_at = NOW() WHERE id = $1`, [pay.id]);
      const r1 = await producePaymentNotifications(client, { windowHours: 1 });
      const r2 = await producePaymentNotifications(client, { windowHours: 1 });
      check("pago: 1ª corrida crea, 2ª no", r1.created >= 1 && r2.created === 0, `${r1.created}/${r2.created}`);
      // Linkear ese pago a OTRA orden crea una aplicación nueva: NO es otro aviso.
      const other = (await client.query(`SELECT id FROM "order" WHERE deleted_at IS NULL AND status = 'pending' LIMIT 1`)).rows[0];
      if (other) {
        await client.query(`INSERT INTO payment_application (id, payment_id, invoice_id, order_id, amount_applied, applied_at, created_at, updated_at, raw_amount_applied)
                            VALUES ('papp_verify', $1, NULL, $2, 100, NOW(), NOW(), NOW(), '{"value":"100","precision":20}'::jsonb)`, [pay.id, other.id]);
        const r3 = await producePaymentNotifications(client, { windowHours: 1 });
        check("pago: linkear el pago a otra orden NO avisa de nuevo", r3.created === 0);
      }
    }
    const cm = (await client.query(
      `SELECT id FROM customer_payment WHERE deleted_at IS NULL AND type = 'credit_memo' LIMIT 1`
    )).rows[0];
    if (cm) {
      await client.query(`UPDATE customer_payment SET created_at = NOW() WHERE id = $1`, [cm.id]);
      await producePaymentNotifications(client, { windowHours: 1 });
      const none = await client.query(`SELECT 1 FROM pos_notification WHERE dedupe_key = $1`, [`payment_received:${cm.id}`]);
      check("pago: un credit memo NO es dinero recibido", none.rowCount === 0);
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

function rawAdapter(client: Client): RawSql {
  return {
    raw: async (sql, bindings = []) => {
      let i = 0;
      const converted = sql.replace(/\?/g, () => `$${++i}`);
      const r = await client.query(converted, bindings as unknown[]);
      return { rows: r.rows as unknown[] };
    },
  };
}

// ─── §5 fase 2 ───────────────────────────────────────────────────────────────
function section5static(): void {
  console.log("\n§5a fase 2 — puro y estático");
  const invites = pendingInvitationsOf([
    { id: "ev1", summary: "Meet", start: { dateTime: "2026-09-20T10:00:00-04:00" }, organizer: { email: "Boss@ecopowertech.com", self: false }, attendees: [{ email: "me@x", self: true, responseStatus: "needsAction" }] },
    { id: "ev2", summary: "Done", start: { date: "2026-09-21" }, attendees: [{ email: "me@x", self: true, responseStatus: "accepted" }] },
    { id: "ev3", summary: "Mine", start: { date: "2026-09-22" }, organizer: { self: true }, attendees: [{ email: "me@x", self: true, responseStatus: "needsAction" }] },
    { id: "ev4", summary: "Cancelled", status: "cancelled", start: { date: "2026-09-23" }, attendees: [{ email: "me@x", self: true, responseStatus: "needsAction" }] },
  ]);
  check("invitaciones: sólo self+needsAction, no propias ni canceladas", invites.length === 1 && invites[0].id === "ev1" && invites[0].organizer_email === "boss@ecopowertech.com" && !invites[0].all_day);
  const body = rsvpPatchBody("me@ecopowertech.com", "accepted");
  check("rsvp: attendeesOmitted + un solo attendee", body.attendeesOmitted === true && body.attendees?.length === 1 && body.attendees[0].responseStatus === "accepted");
  check("weekBucket cambia cada 7 días", weekBucket(new Date("2026-09-17T12:00:00Z")) === weekBucket(new Date("2026-09-20T12:00:00Z")) && weekBucket(new Date("2026-09-17T12:00:00Z")) !== weekBucket(new Date("2026-09-25T12:00:00Z")));
  check("estimates: sólo entregados al cliente", AWAITING_STATUSES.includes("sent by email") && AWAITING_STATUSES.includes("provided in store") && !AWAITING_STATUSES.includes("created"));
  const est = buildEstimateNotification({ id: "o1", display_id: 5, document_number: "E5", order_status: "Sent by Email", rep_initials: "AG", updated_at: "2026-09-01T00:00:00Z", company_name: "ACME", first_name: null, last_name: null, email: null }, new Date("2026-09-17T12:00:00Z"));
  check("estimate: 16 días, al rep, expira", est.title.includes("16 days") && est.audiences[0].kind === "rep" && !!est.expires_at);
  check("newlySeparable: sólo 0→>0 con pendiente", JSON.stringify(newlySeparable(new Map([["a", { pending: 2, available: 0 }], ["b", { pending: 2, available: 1 }]]), new Map([["a", { pending: 2, available: 2 }], ["b", { pending: 2, available: 2 }], ["c", { pending: 0, available: 3 }]]))) === JSON.stringify(["a"]));

  const rsvp = codeLines(read("src/api/admin/pos/calendar/events/[eventId]/rsvp/route.ts")).join("\n");
  check("rsvp: impersona al actor del JWT (resolveAccessLevel), sin user_id", /resolveAccessLevel\(req\)/.test(rsvp) && !/[.[]\s*["']?user_id/.test(rsvp));
  check("rsvp: fuera de dominio → 409", /status\(409\)/.test(rsvp));
  const client = read("src/lib/calendar/google-calendar-client.ts");
  check("calendar client: scope sigue calendar.events.owned", /calendar\.events\.owned"/.test(client) && !/calendar\.readonly|auth\/calendar"/.test(client));
  const route = read("src/api/admin/purchase-orders/[id]/receive/route.ts");
  const hookLines = route.split("\n").filter((l) => /separationBeforeReceipt|notifySeparableAfterReceipt|separationBefore/.test(l) && !/^import/.test(l));
  check("receive route: hook en ≤ 6 líneas de código", hookLines.length >= 2 && hookLines.length <= 6, `${hookLines.length}`);
  const hook = read("src/lib/notifications/producers/separable-hook.ts");
  check("hook: las dos mitades tragan errores (try/catch)", (hook.match(/catch \(err\)/g) ?? []).length === 2);
  const resolver = read("src/lib/notifications/producers/resolver.ts");
  const rules = (resolver.match(/name: "/g) ?? []).length;
  check("resolver: toda regla acotada por kind", rules >= 7 && (resolver.match(/n\.kind/g) ?? []).length >= rules, `${rules} reglas`);
}

async function section5db(): Promise<void> {
  console.log("\n§5b fase 2 — base de datos (transacción con ROLLBACK)");
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("⏭️  sin DATABASE_URL — se omite"); return; }
  const client = new Client({ connectionString: url });
  await client.connect();
  const raw = rawAdapter(client);
  try {
    await client.query("BEGIN");
    const staff = await resolveRecipients(client, [{ kind: "all" }]);

    // ── recibo → separable: elegir una orden con pendiente y stock, forzar 0, restaurar
    const items = (await client.query<{ inventory_item_id: string }>(
      `SELECT DISTINCT ri.inventory_item_id FROM reservation_item ri
         JOIN order_item oi ON oi.item_id = ri.line_item_id AND oi.deleted_at IS NULL
         JOIN "order" o ON o.id = oi.order_id AND o.version = oi.version AND o.status = 'pending' AND o.is_draft_order = false
        WHERE ri.deleted_at IS NULL LIMIT 40`
    )).rows.map((r) => r.inventory_item_id);
    const candidates = await candidateOrdersForItems(raw, items);
    const base = await snapshotSeparation(raw, candidates);
    const target = [...base.entries()].find(([, p]) => p.pending > 0 && p.available > 0);
    check("separable: hay una orden con pendiente y stock para probar", Boolean(target), `${candidates.length} candidatas`);
    if (target) {
      const [orderId] = target;
      const orderItems = (await client.query<{ inventory_item_id: string }>(
        `SELECT DISTINCT ri.inventory_item_id FROM reservation_item ri
           JOIN order_item oi ON oi.item_id = ri.line_item_id AND oi.deleted_at IS NULL
          WHERE oi.order_id = $1 AND ri.deleted_at IS NULL`, [orderId]
      )).rows.map((r) => r.inventory_item_id);
      await client.query(`UPDATE inventory_level SET stocked_quantity = 0, raw_stocked_quantity = jsonb_build_object('value','0','precision',20) WHERE inventory_item_id = ANY($1::text[]) AND location_id = $2`, [orderItems, USA_LOC]);
      const before = await snapshotSeparation(raw, [orderId]);
      check("separable: sin stock → available 0", (before.get(orderId)?.available ?? -1) === 0);
      // "llega el PO": stock de sobra en el ítem (la tx entera se rollbackea al final)
      await client.query(`UPDATE inventory_level SET stocked_quantity = 1000, raw_stocked_quantity = jsonb_build_object('value','1000','precision',20) WHERE inventory_item_id = ANY($1::text[]) AND location_id = $2`, [orderItems, USA_LOC]);
      const out = await produceSeparableAfterReceipt(client, raw, { receipt: { id: "rcp_verify", number: "RCP-VERIFY", po_number: "PO-VERIFY" }, before, orderIds: [orderId] });
      check("separable: tras el recibo cruza y avisa", out.crossed.includes(orderId) && out.results.some((r) => r.created), `${out.crossed.length} cruzadas`);
      const again = await produceSeparableAfterReceipt(client, raw, { receipt: { id: "rcp_verify", number: "RCP-VERIFY", po_number: "PO-VERIFY" }, before: await snapshotSeparation(raw, [orderId]), orderIds: [orderId] });
      check("separable: ya separable antes → no cruza", again.crossed.length === 0);
      const row = (await client.query(`SELECT title, action_url FROM pos_notification WHERE dedupe_key = $1`, [`separable:rcp_verify:${orderId}`])).rows[0];
      check("separable: título con PO y link a la orden", /can be separated — PO-VERIFY received/.test(row?.title ?? "") && row?.action_url === `/orders/${orderId}`);
      await client.query(`UPDATE "order" SET status = 'canceled' WHERE id = $1`, [orderId]);
      const res1 = await resolveOrphanNotifications(client);
      check("resolver: orden cancelada → separable resuelta", res1.order_canceled >= 1);
    }

    // ── accounting
    const cr = (await client.query(`SELECT id FROM commission_request WHERE deleted_at IS NULL LIMIT 1`)).rows[0];
    const pb = (await client.query(`SELECT id FROM price_change_batch WHERE deleted_at IS NULL LIMIT 1`)).rows[0];
    const rf = (await client.query(`SELECT id FROM customer_payment WHERE deleted_at IS NULL AND type = 'payment' AND status = 'applied' LIMIT 1`)).rows[0];
    if (cr) await client.query(`UPDATE commission_request SET status = 'pending', requested_at = NOW() WHERE id = $1`, [cr.id]);
    if (pb) await client.query(`UPDATE price_change_batch SET status = 'submitted', submitted_at = NOW(), updated_at = NOW() WHERE id = $1`, [pb.id]);
    if (rf) await client.query(`UPDATE customer_payment SET status = 'refunded', updated_at = NOW() WHERE id = $1`, [rf.id]);
    const payBefore = (await client.query(`SELECT COUNT(*)::int AS n FROM pos_notification WHERE kind = 'payment_received' AND resolved_at IS NULL`)).rows[0].n as number;
    const acc1 = await produceAccountingNotifications(client, { windowHours: 1 });
    const acc2 = await produceAccountingNotifications(client, { windowHours: 1 });
    const expected = [cr, pb, rf].filter(Boolean).length;
    check("accounting: una por pendiente, 2ª corrida 0", acc1.created === expected && acc2.created === 0, `${acc1.created}/${expected} · ${acc2.created}`);
    const accRecips = (await client.query(`SELECT COUNT(DISTINCT r.user_id)::int AS n FROM pos_notification_recipient r JOIN pos_notification n ON n.id = r.notification_id WHERE n.kind IN ('commission_request_pending','price_batch_submitted','refund_pending')`)).rows[0].n as number;
    const accounting = await resolveRecipients(client, [{ kind: "accounting" }]);
    check("accounting: destinatarios = Accounting (grant + owner), no todo el staff", accRecips <= accounting.length && accRecips < staff.length, `${accRecips} vs accounting=${accounting.length} staff=${staff.length}`);
    if (cr) await client.query(`UPDATE commission_request SET status = 'approved' WHERE id = $1`, [cr.id]);
    if (pb) await client.query(`UPDATE price_change_batch SET status = 'approved' WHERE id = $1`, [pb.id]);
    if (rf) await client.query(`UPDATE customer_payment SET status = 'applied' WHERE id = $1`, [rf.id]);
    const res2 = await resolveOrphanNotifications(client);
    check("resolver: pendientes revisados → resueltos", (res2.commission_request_reviewed + res2.price_batch_reviewed + res2.refund_settled) === expected, JSON.stringify(res2));
    const payAfter = (await client.query(`SELECT COUNT(*)::int AS n FROM pos_notification WHERE kind = 'payment_received' AND resolved_at IS NULL`)).rows[0].n as number;
    check("resolver: refund_settled NO toca los avisos de pago (mismo entity_type)", payAfter === payBefore, `${payBefore}→${payAfter}`);

    // ── estimates
    const est = (await client.query(`SELECT id FROM "order" WHERE deleted_at IS NULL AND status = 'draft' AND is_draft_order = true AND COALESCE(btrim(metadata->'sales_rep'->>'initials'),'') <> '' LIMIT 1`)).rows[0];
    if (est) {
      await client.query(`UPDATE "order" SET metadata = metadata || '{"order_status":"Sent by Email"}', updated_at = NOW() - INTERVAL '10 days' WHERE id = $1`, [est.id]);
      await client.query(`DELETE FROM pos_notification WHERE kind = 'estimate_stale'`);
      const now = new Date();
      const e1 = await produceStaleEstimates(client, { now });
      const e2 = await produceStaleEstimates(client, { now });
      const e3 = await produceStaleEstimates(client, { now: new Date(now.getTime() + 8 * 86_400_000) });
      check("estimates: 1ª crea, misma semana 0, semana siguiente re-avisa", e1.created >= 1 && e2.created === 0 && e3.created >= 1, `${e1.created}/${e2.created}/${e3.created}`);
      await client.query(`UPDATE "order" SET metadata = metadata || '{"order_status":"Created"}' WHERE id = $1`, [est.id]);
      const c1 = await produceStaleEstimates(client, { now: new Date(now.getTime() + 16 * 86_400_000) });
      check("estimates: un 'Created' (nunca entregado) no avisa", !c1.results.some((r) => r.created && r.notification_id && false) && (await client.query(`SELECT COUNT(*)::int AS n FROM pos_notification WHERE kind='estimate_stale' AND entity_id=$1 AND dedupe_key LIKE '%:' || $2`, [est.id, String(weekBucket(new Date(now.getTime() + 16 * 86_400_000)))])).rows[0].n === 0);
      const res3 = await resolveOrphanNotifications(client);
      check("resolver: estimate que dejó de estar entregado → resuelto", res3.estimate_converted_or_closed >= 1);
    }

    // ── calendar con fetch inyectado (Google jamás)
    const domainUser = (await client.query(`SELECT u.id FROM "user" u JOIN pos_user p ON lower(p.email)=lower(u.email) AND p.deleted_at IS NULL WHERE u.deleted_at IS NULL AND lower(u.email) LIKE '%@ecopowertech.com' AND lower(u.email) NOT LIKE 'webhook@%' LIMIT 1`)).rows[0];
    if (domainUser && process.env.GMAIL_SERVICE_ACCOUNT_KEY) {
      const fake = { id: "evt_verify", title: "Verify", start: "2026-09-20", all_day: true, organizer_email: "boss@ecopowertech.com" };
      const c1 = await produceCalendarInvites(client, { fetch: async () => [fake] });
      const c2 = await produceCalendarInvites(client, { fetch: async () => [fake] });
      check("calendar: una por invitación, 2ª corrida 0", c1.created >= 1 && c2.created === 0, `${c1.created}/${c2.created}`);
      const recips = (await client.query(`SELECT r.user_id FROM pos_notification_recipient r JOIN pos_notification n ON n.id = r.notification_id WHERE n.dedupe_key = $1`, [inviteDedupeKey(domainUser.id, "evt_verify")])).rows;
      check("calendar: sólo el invitado la recibe", recips.length === 1 && recips[0].user_id === domainUser.id);
      const c3 = await produceCalendarInvites(client, { fetch: async () => [] });
      check("calendar: respondida en Google → resuelta", c3.resolved >= 1);
    } else {
      console.log("⏭️  calendar DB: sin usuario del dominio o sin GMAIL_SERVICE_ACCOUNT_KEY — se omite");
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
  section5static();
  await section5db();
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
