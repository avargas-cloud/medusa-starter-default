/**
 * E2E sandbox — durable native Medusa order completion.
 *
 * Covers three independent orders:
 *   A. A normal late final payment completes immediately.
 *   B. The final-payment edge loses the advisory lock; the reconciler recovers.
 *   C. An open credit memo blocks completion, then is voided without an event;
 *      the reconciler recovers and a repeated sweep does not complete twice.
 *
 * QuickBooks, SMTP and the real payment processor must remain disabled. Run via
 * `medusa exec` so the reconciler receives a real sandbox Medusa container.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Client, Pool } from "pg";

import { maybeCompleteOrder } from "../../lib/maybe-complete-order";
import { reconcileNativeOrderCompletions } from "../../lib/order-completion/reconciler";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";
const API_URL = process.env.SANDBOX_API ?? "http://localhost:9099";
const MEILI_URL = process.env.MEILISEARCH_HOST ?? "http://localhost:7799";
const MEILI_KEY = process.env.MEILISEARCH_API_KEY ?? "sandbox_master_key";
const EMAIL = process.env.SANDBOX_EMAIL ?? "sandbox@test.com";
const PASSWORD = process.env.SANDBOX_PASSWORD ?? "sandbox123";

interface FixtureSeed {
  customerId: string;
  email: string;
  locationId: string;
  sku: string | null;
  title: string;
  variantId: string;
}

interface TestOrder {
  displayId: number;
  invoiceId: string;
  lineItemId: string;
  orderId: string;
  quantity: number;
  totalCents: number;
}

interface AuditRow {
  outcome: "completed" | "skipped";
  reason: string | null;
  source: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout esperando ${label}`);
}

async function login(): Promise<string> {
  const response = await fetch(`${API_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = (await response.json()) as { token?: string; message?: string };
  if (!response.ok || !body.token) {
    throw new Error(
      `login sandbox falló (${response.status}): ${body.message ?? "sin token"}`
    );
  }
  return body.token;
}

async function api<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {}
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.idempotencyKey
        ? { "Idempotency-Key": init.idempotencyKey }
        : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} → ${response.status}: ${text.slice(0, 500)}`
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function loadSeed(db: Pool): Promise<FixtureSeed> {
  const result = await db.query<FixtureSeed>(
    `SELECT
       c.id AS "customerId",
       c.email,
       sl.id AS "locationId",
       pv.sku,
       COALESCE(NULLIF(p.title, ''), NULLIF(pv.title, ''), 'E2E item') AS title,
       pv.id AS "variantId"
     FROM customer c
     JOIN LATERAL (
       SELECT pv0.id, pv0.sku, pv0.title, pv0.product_id, il.location_id
       FROM product_variant pv0
       JOIN product_variant_inventory_item pvii
         ON pvii.variant_id = pv0.id
        AND pvii.deleted_at IS NULL
       JOIN inventory_level il
         ON il.inventory_item_id = pvii.inventory_item_id
        AND il.deleted_at IS NULL
       WHERE pv0.deleted_at IS NULL
       ORDER BY
         (COALESCE(il.stocked_quantity, 0) - COALESCE(il.reserved_quantity, 0)) DESC,
         pv0.id
       LIMIT 1
     ) pv ON true
     JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
     JOIN stock_location sl ON sl.id = pv.location_id AND sl.deleted_at IS NULL
     WHERE c.deleted_at IS NULL
       AND c.has_account = true
     ORDER BY c.created_at ASC
     LIMIT 1`
  );
  const seed = result.rows[0];
  assert(seed, "sandbox sin customer/variant/location utilizable");
  return seed;
}

async function createOrder(
  token: string,
  db: Pool,
  seed: FixtureSeed,
  quantity: number,
  tag: string
): Promise<TestOrder> {
  const unitPrice = 1_100 + quantity;
  const totalCents = unitPrice * quantity;
  const regions = await api<{ regions: Array<{ id: string }> }>(
    token,
    "/admin/regions?limit=1"
  );
  const regionId = regions.regions[0]?.id;
  assert(regionId, "sandbox sin región");

  const draft = await api<{ draft_order: { id: string } }>(
    token,
    "/admin/draft-orders",
    {
      method: "POST",
      body: {
        email: seed.email,
        customer_id: seed.customerId,
        region_id: regionId,
        items: [],
        metadata: {
          pos_created: true,
          document_number: `E2E-NATIVE-${tag}-${Date.now()}`,
          native_completion_e2e: tag,
        },
      },
    }
  );
  const orderId = draft.draft_order.id;

  await api(token, `/admin/draft-orders/${orderId}/add-item-force`, {
    method: "POST",
    body: {
      variant_id: seed.variantId,
      quantity,
      unit_price: unitPrice,
      custom_title: `${seed.title} — native completion ${tag}`,
      sort_order: 0,
    },
  });
  await api(token, `/admin/draft-orders/${orderId}/convert-force`, {
    method: "POST",
    body: {},
  });

  const orderResult = await db.query<{
    display_id: number;
    is_draft_order: boolean;
    line_item_id: string;
  }>(
    `SELECT o.display_id, o.is_draft_order, li.id AS line_item_id
       FROM "order" o
       JOIN order_item oi
         ON oi.order_id = o.id
        AND oi.version = o.version
        AND oi.deleted_at IS NULL
       JOIN order_line_item li ON li.id = oi.item_id
      WHERE o.id = $1
      LIMIT 1`,
    [orderId]
  );
  const row = orderResult.rows[0];
  assert(
    row && row.is_draft_order === false,
    `${tag}: el draft no se convirtió`
  );

  const invoice = await api<{ invoice: { id: string } }>(
    token,
    "/admin/invoices",
    {
      method: "POST",
      idempotencyKey: `native-completion-e2e-${orderId}`,
      body: {
        order_id: orderId,
        order_display_id: row.display_id,
        customer_id: seed.customerId,
        items: [
          {
            variant_id: seed.variantId,
            sku: seed.sku,
            description: `${seed.title} — native completion ${tag}`,
            quantity,
            unit_price: unitPrice,
            total: totalCents,
            net_total: totalCents,
          },
        ],
        subtotal: totalCents,
        discount: 0,
        shipping: 0,
        tax: 0,
        total: totalCents,
        amount_paid: 0,
        payment_method: null,
        order_document_number: `E2E-${tag}`,
        send_email: false,
        is_sales_receipt: false,
      },
    }
  );

  return {
    displayId: row.display_id,
    invoiceId: invoice.invoice.id,
    lineItemId: row.line_item_id,
    orderId,
    quantity,
    totalCents,
  };
}

async function fulfill(
  token: string,
  seed: FixtureSeed,
  order: TestOrder
): Promise<void> {
  await api(token, `/admin/orders/${order.orderId}/create-fulfillment-force`, {
    method: "POST",
    body: {
      items: [{ id: order.lineItemId, quantity: order.quantity }],
      location_id: seed.locationId,
      no_notification: true,
      mark_as_delivered: true,
    },
  });
}

async function pay(
  token: string,
  seed: FixtureSeed,
  order: TestOrder,
  amount: number,
  reference: string
): Promise<void> {
  await api(token, `/admin/invoices/${order.invoiceId}/payments`, {
    method: "POST",
    body: {
      amount,
      payment_method: "cash",
      customer_id: seed.customerId,
      reference,
      notes: "sandbox E2E native order completion",
    },
  });
}

async function orderStatus(db: Pool, orderId: string): Promise<string> {
  const result = await db.query<{ status: string }>(
    `SELECT status FROM "order" WHERE id = $1`,
    [orderId]
  );
  assert(result.rows[0], `orden ${orderId} no encontrada`);
  return result.rows[0].status;
}

async function audits(db: Pool, orderId: string): Promise<AuditRow[]> {
  const result = await db.query<AuditRow>(
    `SELECT source, outcome, reason
       FROM order_completion_attempt
      WHERE order_id = $1
      ORDER BY id ASC`,
    [orderId]
  );
  return result.rows;
}

async function waitForAudit(
  db: Pool,
  orderId: string,
  predicate: (row: AuditRow) => boolean,
  label: string
): Promise<void> {
  await waitFor(label, async () => (await audits(db, orderId)).some(predicate));
}

async function waitForMeiliClosed(orderId: string): Promise<void> {
  await waitFor(
    `Meili is_closed=true para ${orderId}`,
    async () => {
      const response = await fetch(
        `${MEILI_URL}/indexes/orders/documents/${encodeURIComponent(orderId)}`,
        { headers: { Authorization: `Bearer ${MEILI_KEY}` } }
      );
      if (response.status === 404) return false;
      if (!response.ok) {
        throw new Error(`Meili documents → ${response.status}`);
      }
      const document = (await response.json()) as {
        is_closed?: boolean;
        status?: string;
      };
      return document.is_closed === true && document.status === "completed";
    },
    25_000
  );
}

export default async function run({ container }: ExecArgs): Promise<void> {
  assert(
    process.env.ECOPOWERTECH_ENV === "sandbox",
    "ABORT: este E2E sólo puede correr con ECOPOWERTECH_ENV=sandbox"
  );
  assert(
    DATABASE_URL.includes("localhost:5499"),
    "ABORT: DATABASE_URL no apunta al Postgres sandbox :5499"
  );
  assert(
    process.env.QB_BRIDGE_URL?.includes("localhost:9999/disabled"),
    "ABORT: QB_BRIDGE_URL debe ser el bridge deshabilitado del sandbox"
  );

  const db = new Pool({ connectionString: DATABASE_URL });
  const token = await login();
  const seed = await loadSeed(db);
  const created: TestOrder[] = [];

  try {
    console.log("\nA — pago final tardío completa por la ruta HTTP");
    const normal = await createOrder(token, db, seed, 1, "NORMAL");
    created.push(normal);
    await fulfill(token, seed, normal);
    await pay(token, seed, normal, 400, `E2E-NORMAL-PART-${Date.now()}`);
    assert(
      (await orderStatus(db, normal.orderId)) === "pending",
      "A: el pago parcial cerró la orden"
    );
    await waitForAudit(
      db,
      normal.orderId,
      (row) => row.reason === "not_fully_paid",
      "audit not_fully_paid A"
    );
    await pay(
      token,
      seed,
      normal,
      normal.totalCents - 400,
      `E2E-NORMAL-FINAL-${Date.now()}`
    );
    await waitFor(
      "orden A completed",
      async () => (await orderStatus(db, normal.orderId)) === "completed"
    );
    await waitForAudit(
      db,
      normal.orderId,
      (row) =>
        row.source === "invoice_payment_recorded" &&
        row.outcome === "completed",
      "audit completed A"
    );
    await waitForMeiliClosed(normal.orderId);

    console.log("B — lock busy y recuperación por reconciliador");
    const locked = await createOrder(token, db, seed, 2, "LOCKED");
    created.push(locked);
    await fulfill(token, seed, locked);
    await pay(token, seed, locked, 500, `E2E-LOCKED-PART-${Date.now()}`);

    const lockClient = new Client({ connectionString: DATABASE_URL });
    await lockClient.connect();
    try {
      await lockClient.query(`SELECT pg_advisory_lock(hashtext($1))`, [
        `complete-order:${locked.orderId}`,
      ]);
      await pay(
        token,
        seed,
        locked,
        locked.totalCents - 500,
        `E2E-LOCKED-FINAL-${Date.now()}`
      );
      await waitForAudit(
        db,
        locked.orderId,
        (row) => row.reason === "busy",
        "audit busy B"
      );
      assert(
        (await orderStatus(db, locked.orderId)) === "pending",
        "B: se completó mientras el lock estaba tomado"
      );
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
        `complete-order:${locked.orderId}`,
      ]);
      await lockClient.end();
    }

    const lockedSweep = await reconcileNativeOrderCompletions(container, {
      orderIds: [locked.orderId],
      minAgeSeconds: 0,
      source: "scheduled_reconciler",
    });
    assert(
      lockedSweep.completed === 1,
      `B: reconciliador completó ${lockedSweep.completed}, esperaba 1`
    );
    assert(
      (await orderStatus(db, locked.orderId)) === "completed",
      "B: quedó pendiente después del reconciliador"
    );
    await waitForMeiliClosed(locked.orderId);

    console.log("C — crédito abierto, void sin evento y recuperación durable");
    const credit = await createOrder(token, db, seed, 3, "CREDIT");
    created.push(credit);
    await pay(
      token,
      seed,
      credit,
      credit.totalCents,
      `E2E-CREDIT-FULL-${Date.now()}`
    );
    await waitForAudit(
      db,
      credit.orderId,
      (row) => row.reason === "not_fully_fulfilled",
      "audit not_fully_fulfilled C"
    );

    const creditMemoId = `pcm_native_e2e_${Date.now()}`;
    await db.query(
      `INSERT INTO pos_credit_memo
        (id, credit_memo_number, order_id, invoice_id, customer_id, status)
       VALUES ($1, $2, $3, $4, $5, 'created')`,
      [
        creditMemoId,
        `CM-E2E-${Date.now()}`,
        credit.orderId,
        credit.invoiceId,
        seed.customerId,
      ]
    );
    await fulfill(token, seed, credit);
    await waitForAudit(
      db,
      credit.orderId,
      (row) => row.reason === "open_credit_memo",
      "audit open_credit_memo C"
    );
    assert(
      (await orderStatus(db, credit.orderId)) === "pending",
      "C: cerró con credit memo abierto"
    );

    await db.query(
      `UPDATE pos_credit_memo
          SET status = 'voided', voided_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [creditMemoId]
    );
    const creditSweep = await reconcileNativeOrderCompletions(container, {
      orderIds: [credit.orderId],
      minAgeSeconds: 0,
      source: "scheduled_reconciler",
    });
    assert(
      creditSweep.completed === 1,
      "C: el reconciliador no recuperó la orden"
    );
    await waitForMeiliClosed(credit.orderId);

    const completedBefore = (await audits(db, credit.orderId)).filter(
      (row) => row.outcome === "completed"
    ).length;
    const repeated = await reconcileNativeOrderCompletions(container, {
      orderIds: [credit.orderId],
      minAgeSeconds: 0,
      source: "scheduled_reconciler",
    });
    const directRepeated = await maybeCompleteOrder(container, credit.orderId, {
      source: "scheduled_reconciler",
    });
    const completedAfter = (await audits(db, credit.orderId)).filter(
      (row) => row.outcome === "completed"
    ).length;
    assert(
      repeated.candidates.length === 0,
      "C: sweep repetido volvió a elegirla"
    );
    assert(
      !directRepeated.completed &&
        directRepeated.reason === "status_not_pending",
      "C: la llamada idempotente no devolvió status_not_pending"
    );
    assert(
      completedAfter === completedBefore,
      "C: se registró una segunda finalización"
    );

    console.log("\n✅ E2E native completion PASS");
    for (const order of created) {
      const rows = await audits(db, order.orderId);
      console.log(
        `   #${order.displayId} ${order.orderId}: ${await orderStatus(
          db,
          order.orderId
        )} · ${rows.map((row) => `${row.source}:${row.reason ?? row.outcome}`).join(", ")}`
      );
    }
  } finally {
    await db.end();
  }
}
