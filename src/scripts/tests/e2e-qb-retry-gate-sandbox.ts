/**
 * e2e-qb-retry-gate-sandbox.ts — Retry gate del botón Retry contra el sandbox.
 *
 * `POST /admin/quickbooks/pipeline?action=retry&id=<rowId>` ahora consulta
 * `evaluateRetryGate` ANTES de reclamar la fila. Cubre el escenario central
 * (un ADD ambiguo se bloquea con 409 y la fila queda INTACTA), su control
 * positivo (la misma forma de fila con un error que QB SÍ contestó pasa), y
 * los cuatro "no bloquea de más" que hacen que el gate discrimine de verdad
 * en vez de rechazar todo lo que tenga `bridge_op_id`.
 *
 * Filas SINTÉTICAS en `qb_order_pipeline`, prefijo `e2ergate_` (limpiadas al
 * arrancar y al terminar — el script es repetible).
 *
 * Uso (NUNCA contra producción — aborta si la DB no es :5499):
 *   env DATABASE_URL="postgres://postgres:sandbox@127.0.0.1:5499/medusa" \
 *       SANDBOX_URL="http://localhost:9099" \
 *       SANDBOX_ADMIN_EMAIL=... SANDBOX_ADMIN_PASSWORD=... \
 *       QB_BRIDGE_URL="http://127.0.0.1:1" \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-qb-retry-gate-sandbox.ts
 */
import { Pool } from "pg";

const BASE = process.env.SANDBOX_URL ?? "http://localhost:9099";
const ADMIN_EMAIL = process.env.SANDBOX_ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.SANDBOX_ADMIN_PASSWORD ?? "";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

interface FetchResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  token: string,
  method: string,
  path: string
): Promise<FetchResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: parsed };
}

type FixtureRow = {
  refId: string;
  step: string;
  bridge_op_id: string | null;
  qb_txn_id: string | null;
  error: string;
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!/127\.0\.0\.1:5499|localhost:5499/.test(url)) {
    console.error(`ABORT: DATABASE_URL no apunta al sandbox (:5499).`);
    process.exit(2);
  }
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error("ABORT: faltan SANDBOX_ADMIN_EMAIL / SANDBOX_ADMIN_PASSWORD.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });

  // ── Reset al arrancar ───────────────────────────────────────────────────────
  // `id` es uuid, no texto — el identificador propio del fixture (y la clave de
  // limpieza) vive en `reference_id`, prefijado `e2ergate_`.
  await pool.query(`DELETE FROM qb_order_pipeline WHERE reference_id LIKE 'e2ergate_%'`);

  // ── Login ────────────────────────────────────────────────────────────────
  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const auth = (await authRes.json().catch(() => ({}))) as { token?: string };
  if (!auth.token) {
    console.error(`ABORT: login falló (${authRes.status}).`);
    process.exit(2);
  }
  const token = auth.token;

  // ── Fixtures ─────────────────────────────────────────────────────────────
  const fixtures: FixtureRow[] = [
    {
      refId: "e2ergate_s1_ambiguous_add",
      step: "credit_memo",
      bridge_op_id: "op-e2e-ambiguo",
      qb_txn_id: null,
      error: "Timed out before submitted state (>20 min) — no response from QB bridge",
    },
    {
      refId: "e2ergate_s2_qb_answered",
      step: "credit_memo",
      bridge_op_id: "op-e2e-ambiguo-control",
      qb_txn_id: null,
      error: "QuickBooks Error 3200: The name already exists.",
    },
    {
      refId: "e2ergate_s3_readonly_query",
      step: "vendor_bill_payment_check",
      bridge_op_id: "op-e2e-query",
      qb_txn_id: null,
      error: "Timed out before submitted state (>20 min) — no response from QB bridge",
    },
    {
      refId: "e2ergate_s4_pipeline_verdict",
      step: "sales_order",
      bridge_op_id: "op-e2e-superseded",
      qb_txn_id: null,
      error: "Superseded by Invoice/Sales Receipt — Sales Order not needed",
    },
    {
      refId: "e2ergate_s5_no_bridge_op_id",
      step: "credit_memo",
      bridge_op_id: null,
      qb_txn_id: null,
      error: "Timed out before submitted state (>20 min) — no response from QB bridge",
    },
    {
      refId: "e2ergate_s6_qb_txn_id_present",
      step: "invoice",
      bridge_op_id: "op-e2e-mod",
      qb_txn_id: "1C1234-1780000000",
      error: "Timed out before submitted state (>20 min) — no response from QB bridge",
    },
  ];

  const rowIds = new Map<string, string>();
  for (const f of fixtures) {
    const { rows: inserted } = await pool.query<{ id: string }>(
      `INSERT INTO qb_order_pipeline
         (order_id, reference_id, reference_type, step, status, bridge_op_id, qb_txn_id, error)
       VALUES ('e2ergate_order', $1, 'e2e', $2, 'failed', $3, $4, $5)
       RETURNING id`,
      [f.refId, f.step, f.bridge_op_id, f.qb_txn_id, f.error]
    );
    rowIds.set(f.refId, inserted[0].id);
  }
  console.log(`Fixtures insertadas: ${fixtures.length}\n`);

  const retryPath = (refId: string): string =>
    `/admin/quickbooks/pipeline?action=retry&id=${rowIds.get(refId)}`;

  console.log("── §1 · ADD ambiguo se BLOQUEA (escenario central) ──");
  {
    const res = await api(token, "POST", retryPath("e2ergate_s1_ambiguous_add"));
    check(
      "409 con code retry_needs_qb_verification",
      res.status === 409 && res.body.code === "retry_needs_qb_verification",
      `status=${res.status} code=${String(res.body.code)}`
    );

    const { rows } = await pool.query<{
      status: string;
      bridge_op_id: string | null;
      retry_count: number;
    }>(
      `SELECT status, bridge_op_id, retry_count FROM qb_order_pipeline WHERE id = $1`,
      [rowIds.get("e2ergate_s1_ambiguous_add")]
    );
    const r = rows[0];
    check(
      "NO-DAÑO: la fila quedó INTACTA (status/bridge_op_id/retry_count sin tocar)",
      r?.status === "failed" && r?.bridge_op_id === "op-e2e-ambiguo" && Number(r?.retry_count) === 0,
      `status=${r?.status} bridge_op_id=${r?.bridge_op_id} retry_count=${r?.retry_count}`
    );

    check(
      "§7 · la respuesta trae instructions ÚTILES (EntityFilter, no RefNumber)",
      typeof res.body.instructions === "string" &&
        (res.body.instructions as string).includes("EntityFilter") &&
        /RefNumber/i.test(res.body.instructions as string),
      String(res.body.instructions).slice(0, 140)
    );
  }

  console.log("── §2 · CONTROL POSITIVO: la misma forma con error que QB SÍ contestó pasa ──");
  {
    const res = await api(token, "POST", retryPath("e2ergate_s2_qb_answered"));
    check(
      "NO es 409 (el gate discrimina, no bloquea todo lo que tenga bridge_op_id)",
      res.status !== 409,
      `status=${res.status}`
    );
  }

  console.log("── §3 · vendor_bill_payment_check con bridge_op_id pasa (78 filas reales de prod) ──");
  {
    const res = await api(token, "POST", retryPath("e2ergate_s3_readonly_query"));
    check(
      "NO es 409 (read-only BillQuery, no puede duplicar nada)",
      res.status !== 409,
      `status=${res.status}`
    );
  }

  console.log("── §4 · veredicto del pipeline (Superseded) pasa ──");
  {
    const res = await api(token, "POST", retryPath("e2ergate_s4_pipeline_verdict"));
    check(
      "NO es 409 (mensaje es decisión propia, no outcome de QB)",
      res.status !== 409,
      `status=${res.status}`
    );
  }

  console.log("── §5 · ADD sin bridge_op_id pasa (nunca llegó al bridge) ──");
  {
    const res = await api(token, "POST", retryPath("e2ergate_s5_no_bridge_op_id"));
    check(
      "NO es 409",
      res.status !== 409,
      `status=${res.status}`
    );
  }

  console.log("── §6 · qb_txn_id presente pasa (retry va a MOD) ──");
  {
    const res = await api(token, "POST", retryPath("e2ergate_s6_qb_txn_id_present"));
    check(
      "NO es 409",
      res.status !== 409,
      `status=${res.status}`
    );
  }

  // ── Limpieza ────────────────────────────────────────────────────────────
  await pool.query(`DELETE FROM qb_order_pipeline WHERE reference_id LIKE 'e2ergate_%'`);
  const { rows: leftover } = await pool.query(
    `SELECT count(*)::int AS n FROM qb_order_pipeline WHERE reference_id LIKE 'e2ergate_%'`
  );
  check("limpieza: cero filas e2ergate_% remanentes", leftover[0]?.n === 0, `n=${leftover[0]?.n}`);

  await pool.end();
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed · ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
