/**
 * E2E de la protección de órdenes WEB — SANDBOX ONLY.
 *
 * ── Qué protege ───────────────────────────────────────────────────────────────
 * Una orden web es un contrato que el cliente armó solo. Editarla (ítems,
 * descuentos, direcciones, refunds, credit memos) exige PIN de supervisor,
 * verificado en la RUTA; lo operativo (metadata de emails, pos_last_edited_by)
 * pasa libre. Las órdenes POS no se tocan.
 *
 * ── Asimetría de aserciones (igual que e2e-supervisor-pin-gates) ─────────────
 * Un 403 sin PIN NO prueba que el gate funcione (una conexión rota también da
 * 403): lo que prueba es que el PIN CORRECTO es ACEPTADO y el efecto OCURRE.
 * Cada familia lleva negativo (sin PIN → 403 y CERO efecto) y positivo
 * (con PIN → efecto real verificado en DB).
 *
 * ── Qué cubre ─────────────────────────────────────────────────────────────────
 *  A. Ruta NATIVA POST /admin/orders/:id (middleware protect-web-order-fields):
 *     web+campo protegido sin PIN → 403 y metadata intacta · web+operativo sin
 *     PIN → 200 · web+protegido con PIN → 200 y escrito · POS+protegido sin
 *     PIN → 200 (no afectado).
 *  B. post-edit-sync: web sin PIN → 403 · web con PIN + attestation → 200,
 *     claves de descuento persistidas server-side, y UNA huella
 *     web_order_edit con customer_confirmation; repetir el mismo
 *     operation_id NO duplica la huella · POS sin PIN → 200 (control).
 *  C. Refund de customer-payment atado a la orden web: sin PIN → 403
 *     WEB_ORDER_EDIT y el pago intacto · con PIN → avanza (NO 403).
 *  D. Credit memo de la orden web (void): sin PIN → 403 y el CM intacto ·
 *     con PIN → avanza (NO 403).
 *
 * ── Cómo correrlo ─────────────────────────────────────────────────────────────
 *   ./back-sb                       # backend sandbox en :9099 (rama activa)
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-web-order-safety-sandbox.ts
 *
 * Muta el sandbox (convierte una orden a "web" y le apunta un pago y un CM);
 * restaura lo que puede en el finally. El PIN jamás se imprime.
 */
import { Client } from "pg";

const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

function abort(why: string): never {
  console.error(`\n❌ ABORTADO: ${why}\n`);
  process.exit(2);
}

if (!/^http:\/\/(localhost|127\.0\.0\.1):9099(\/|$)/.test(BASE)) {
  abort(`BASE apunta a ${BASE} — este script SOLO corre contra el sandbox :9099.`);
}
if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  abort(`la DB no es la del sandbox (se esperaba localhost:5499).`);
}

interface Result {
  ok: boolean;
  name: string;
}
const results: Result[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ ok, name });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail}`}`);
}

interface Resp {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}
async function call(
  path: string,
  opts: {
    token: string;
    body?: Record<string, unknown>;
    pin?: string;
    method?: string;
  }
): Promise<Resp> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.token}`,
  };
  if (opts.pin !== undefined) headers["x-supervisor-pin"] = opts.pin;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* raw queda para diagnóstico */
  }
  return { status: res.status, body, raw };
}

async function main(): Promise<void> {
  console.log("=== e2e-web-order-safety (sandbox) ===\n");

  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  // ── PIN real (nunca se imprime) ────────────────────────────────────────────
  const { rows: storeRows } = await db.query<{ pin: string | null }>(
    `SELECT metadata->>'pos_supervisor_pin' AS pin FROM store
      WHERE metadata->>'pos_supervisor_pin' IS NOT NULL ORDER BY id LIMIT 1`
  );
  const realPin = storeRows[0]?.pin;
  if (!realPin) {
    await db.end();
    abort(`el store del sandbox no tiene pos_supervisor_pin configurado.`);
  }

  // ── Login ──────────────────────────────────────────────────────────────────
  const email = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
  const password = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const auth = (await authRes.json().catch(() => ({}))) as { token?: string };
  if (!auth.token) {
    await db.end();
    abort(`no se pudo loguear como ${email} (HTTP ${authRes.status}).`);
  }
  const token = auth.token;

  // ── Canal Web (existe en el snapshot de prod) ──────────────────────────────
  const { rows: chRows } = await db.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE name ILIKE 'web%' AND deleted_at IS NULL LIMIT 1`
  );
  const webChannelId = chRows[0]?.id;
  if (!webChannelId) {
    await db.end();
    abort(`el sandbox no tiene sales_channel 'Web'.`);
  }

  // ── Orden de prueba WEB: una confirmada real, convertida ──────────────────
  const { rows: ordRows } = await db.query<{
    id: string;
    display_id: string;
    sales_channel_id: string | null;
    pos_created: string | null;
  }>(
    `SELECT o.id, o.display_id::text, o.sales_channel_id,
            o.metadata->>'pos_created' AS pos_created
       FROM "order" o
      WHERE o.deleted_at IS NULL AND o.is_draft_order = false
        AND o.status = 'pending'
      ORDER BY o.created_at DESC LIMIT 1`
  );
  const webOrder = ordRows[0];
  if (!webOrder) {
    await db.end();
    abort(`no hay orden confirmada 'pending' en el sandbox para convertir.`);
  }

  // ── Orden de control POS (otra, intacta) ───────────────────────────────────
  const { rows: posRows } = await db.query<{ id: string; display_id: string }>(
    `SELECT id, display_id::text FROM "order"
      WHERE deleted_at IS NULL AND is_draft_order = false AND status = 'pending'
        AND id <> $1
        AND metadata->>'pos_created' = 'true'
      ORDER BY created_at DESC LIMIT 1`,
    [webOrder.id]
  );
  const posOrder = posRows[0];
  if (!posOrder) {
    await db.end();
    abort(`no hay segunda orden pending pos_created para control.`);
  }

  console.log(
    `  · orden web de prueba: #${webOrder.display_id} · control POS: #${posOrder.display_id}\n`
  );

  // Pago y CM apuntados a la orden web (para C y D).
  const { rows: payRows } = await db.query<{ id: string; locked: string | null }>(
    `SELECT id, locked_order_id AS locked FROM customer_payment
      WHERE status NOT IN ('voided','refunded') AND type = 'payment'
      ORDER BY created_at DESC LIMIT 1`
  );
  const payment = payRows[0] ?? null;
  const { rows: cmRows } = await db.query<{ id: string; order_id: string | null; status: string }>(
    `SELECT id, order_id, status FROM pos_credit_memo
      WHERE status = 'completed' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`
  );
  const cm = cmRows[0] ?? null;

  const cleanup: Array<() => Promise<void>> = [];
  try {
    // Convertir la orden a WEB
    await db.query(
      `UPDATE "order" SET sales_channel_id = $2,
              metadata = (COALESCE(metadata,'{}'::jsonb) - 'pos_created')
        WHERE id = $1`,
      [webOrder.id, webChannelId]
    );
    cleanup.push(async () => {
      await db.query(
        `UPDATE "order" SET sales_channel_id = $2,
                metadata = COALESCE(metadata,'{}'::jsonb) || '{"pos_created": true}'::jsonb
          WHERE id = $1`,
        [webOrder.id, webOrder.sales_channel_id]
      );
    });
    if (payment) {
      await db.query(
        `UPDATE customer_payment SET locked_order_id = $2 WHERE id = $1`,
        [payment.id, webOrder.id]
      );
      cleanup.push(async () => {
        await db.query(
          `UPDATE customer_payment SET locked_order_id = $2 WHERE id = $1`,
          [payment.id, payment.locked]
        );
      });
    }
    if (cm) {
      await db.query(`UPDATE pos_credit_memo SET order_id = $2 WHERE id = $1`, [
        cm.id,
        webOrder.id,
      ]);
      cleanup.push(async () => {
        await db.query(`UPDATE pos_credit_memo SET order_id = $2 WHERE id = $1`, [
          cm.id,
          cm.order_id,
        ]);
      });
    }

    const meta = async (orderId: string, key: string): Promise<string | null> => {
      const { rows } = await db.query<{ v: string | null }>(
        `SELECT metadata->>$2 AS v FROM "order" WHERE id = $1`,
        [orderId, key]
      );
      return rows[0]?.v ?? null;
    };

    // ── A · Ruta nativa ─────────────────────────────────────────────────────
    console.log("A · ruta nativa POST /admin/orders/:id");
    const beforeDv = await meta(webOrder.id, "discount_value");
    let r = await call(`/admin/orders/${webOrder.id}`, {
      token,
      body: { metadata: { discount_value: 99.99, discount_type: "fixed" } },
    });
    check("A1 web+descuento sin PIN → 403", r.status === 403, `HTTP ${r.status}: ${r.raw.slice(0, 120)}`);
    check(
      "A2 …y la metadata quedó intacta (cero efecto)",
      (await meta(webOrder.id, "discount_value")) === beforeDv,
      `discount_value cambió`
    );
    r = await call(`/admin/orders/${webOrder.id}`, {
      token,
      body: { metadata: { pos_last_edited_by: "e2e-web-safety" } },
    });
    check("A3 web+metadata operativa sin PIN → 200", r.status === 200, `HTTP ${r.status}: ${r.raw.slice(0, 120)}`);
    r = await call(`/admin/orders/${webOrder.id}`, {
      token,
      pin: realPin,
      body: { metadata: { discount_value: 12.34, discount_type: "fixed" } },
    });
    check("A4 web+descuento con PIN correcto → 200", r.status === 200, `HTTP ${r.status}: ${r.raw.slice(0, 120)}`);
    check(
      "A5 …y el valor REALMENTE se escribió",
      (await meta(webOrder.id, "discount_value")) === "12.34",
      `esperaba 12.34, quedó ${await meta(webOrder.id, "discount_value")}`
    );
    // restaurar
    await db.query(
      `UPDATE "order" SET metadata = metadata || jsonb_build_object('discount_value', $2::numeric, 'discount_type', null)
        WHERE id = $1`,
      [webOrder.id, beforeDv]
    );
    r = await call(`/admin/orders/${posOrder.id}`, {
      token,
      body: { metadata: { pos_last_edited_by: "e2e-web-safety-pos-control" } },
    });
    check("A6 orden POS: nativa sin PIN sigue libre → 200", r.status === 200, `HTTP ${r.status}`);

    // ── B · post-edit-sync ──────────────────────────────────────────────────
    console.log("\nB · post-edit-sync (save del POS)");
    r = await call(`/admin/orders/${webOrder.id}/post-edit-sync`, {
      token,
      body: { pos_discount_amount: 0 },
    });
    check("B1 web sin PIN → 403", r.status === 403, `HTTP ${r.status}: ${r.raw.slice(0, 120)}`);

    const opId = `e2e-${Date.now()}`;
    r = await call(`/admin/orders/${webOrder.id}/post-edit-sync`, {
      token,
      pin: realPin,
      body: {
        pos_discount_amount: 0,
        web_edit_operation_id: opId,
        web_edit_attestation: {
          channel: "email",
          reference: "e2e: cliente confirmó por email",
        },
      },
    });
    check("B2 web con PIN → 200", r.status === 200, `HTTP ${r.status}: ${r.raw.slice(0, 200)}`);
    check(
      "B3 claves de descuento persistidas server-side (null explícito)",
      (await meta(webOrder.id, "discount_value")) === null &&
        (await meta(webOrder.id, "discount_type")) === null,
      `discount_value=${await meta(webOrder.id, "discount_value")}`
    );
    const footprints = async (): Promise<number> => {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM order_change
          WHERE order_id = $1 AND change_type = 'pos_activity'
            AND internal_note LIKE $2`,
        [webOrder.id, `%"operation_id":"${opId}"%`]
      );
      return Number(rows[0]?.n ?? 0);
    };
    check("B4 exactamente UNA huella web_order_edit", (await footprints()) === 1, `${await footprints()} huellas`);
    const { rows: noteRows } = await db.query<{ note: string }>(
      `SELECT internal_note AS note FROM order_change
        WHERE order_id = $1 AND internal_note LIKE $2 LIMIT 1`,
      [webOrder.id, `%"operation_id":"${opId}"%`]
    );
    check(
      "B5 la huella lleva customer_confirmation (canal+referencia)",
      /customer_confirmation/.test(noteRows[0]?.note ?? "") &&
        /cliente confirmó por email/.test(noteRows[0]?.note ?? ""),
      noteRows[0]?.note?.slice(0, 160) ?? "(sin huella)"
    );
    r = await call(`/admin/orders/${webOrder.id}/post-edit-sync`, {
      token,
      pin: realPin,
      body: { pos_discount_amount: 0, web_edit_operation_id: opId },
    });
    check(
      "B6 repetir el mismo operation_id NO duplica la huella",
      r.status === 200 && (await footprints()) === 1,
      `HTTP ${r.status}, ${await footprints()} huellas`
    );
    r = await call(`/admin/orders/${posOrder.id}/post-edit-sync`, {
      token,
      body: { pos_discount_amount: 0 },
    });
    check("B7 orden POS: post-edit-sync sin PIN → 200 (control)", r.status === 200, `HTTP ${r.status}: ${r.raw.slice(0, 120)}`);

    // ── C · Refund ──────────────────────────────────────────────────────────
    console.log("\nC · refund de customer-payment atado a la orden web");
    if (payment) {
      const payState = async (): Promise<string> => {
        const { rows } = await db.query<{ s: string }>(
          `SELECT status AS s FROM customer_payment WHERE id = $1`,
          [payment.id]
        );
        return rows[0]?.s ?? "?";
      };
      const before = await payState();
      r = await call(`/admin/customer-payments/${payment.id}/refund`, {
        token,
        body: {},
      });
      check(
        "C1 sin PIN → 403 WEB_ORDER_EDIT",
        r.status === 403 && String(r.body.reason ?? "") === "WEB_ORDER_EDIT",
        `HTTP ${r.status}: ${r.raw.slice(0, 160)}`
      );
      check("C2 …y el pago quedó intacto", (await payState()) === before, `status cambió`);
      r = await call(`/admin/customer-payments/${payment.id}/refund`, {
        token,
        pin: realPin,
        body: { amount: 0.0 },
      });
      check(
        "C3 con PIN correcto → el gate abre (NO 403)",
        r.status !== 403,
        `HTTP ${r.status}: ${r.raw.slice(0, 160)}`
      );
    } else {
      check("C1-C3 (sin pago disponible en sandbox)", false, "no hay customer_payment usable");
    }

    // ── D · Credit memo ─────────────────────────────────────────────────────
    console.log("\nD · credit memo de la orden web (void)");
    if (cm) {
      const cmState = async (): Promise<string> => {
        const { rows } = await db.query<{ s: string }>(
          `SELECT status AS s FROM pos_credit_memo WHERE id = $1`,
          [cm.id]
        );
        return rows[0]?.s ?? "?";
      };
      r = await call(`/admin/pos/credit_memos/${cm.id}/void`, {
        token,
        body: {},
      });
      check(
        "D1 void sin PIN → 403 WEB_ORDER_EDIT",
        r.status === 403 && String(r.body.reason ?? "") === "WEB_ORDER_EDIT",
        `HTTP ${r.status}: ${r.raw.slice(0, 160)}`
      );
      check("D2 …y el CM quedó intacto", (await cmState()) === "completed", `status cambió`);
      // Positivo sin efecto destructivo: PIN correcto sobre la ruta EDIT, que
      // exige body válido — el gate abre y muere después por el body vacío.
      r = await call(`/admin/pos/credit_memos/${cm.id}/edit`, {
        token,
        pin: realPin,
        method: "PATCH",
        body: {},
      });
      check(
        "D3 con PIN correcto → el gate abre (NO 403 de web)",
        r.status !== 403 || String(r.body.reason ?? "") !== "WEB_ORDER_EDIT",
        `HTTP ${r.status}: ${r.raw.slice(0, 160)}`
      );
    } else {
      check("D1-D3 (sin CM disponible en sandbox)", false, "no hay pos_credit_memo completed");
    }
  } finally {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch (e) {
        console.error("  ⚠️ cleanup:", e);
      }
    }
    await db.end();
  }

  // ── Reporte ─────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n=== ${results.length - failed.length}/${results.length} checks OK ===`
  );
  if (failed.length > 0) {
    console.error(`❌ ${failed.length} fallo(s):`);
    for (const f of failed) console.error(`  • ${f.name}`);
    process.exit(1);
  }
  console.log("✅ la protección de órdenes web funciona de punta a punta");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
