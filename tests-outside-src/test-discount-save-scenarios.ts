/**
 * scripts/tests/test-discount-save-scenarios.ts
 *
 * Drives post-edit-sync (and apply-discount-force underneath) against a real
 * order via HTTP, simulating every realistic save scenario and asserting the
 * resulting DB state. Snapshots and restores the order between cases so the
 * test is non-destructive.
 *
 * Target order: S1350 (order_01KP64PS82JB844N64TFJEWA0X) — it has the canonical
 * CPOS-PCT-1200 12% promo and 7 lines summing $7,294.40 (subtotal) → $875.33
 * expected discount → $6,419.07 expected total.
 *
 * Run: yarn ts-node src/scripts/tests/test-discount-save-scenarios.ts
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
import * as jwt from "jsonwebtoken";

dotenv.config({ path: path.join(__dirname, "../.env") });

const TARGET_ORDER = "order_01KP64PS82JB844N64TFJEWA0X";
const ADMIN_USER_ID = "user_01KFHEWY9YFW1CJ4YTHMJP945N";
const BASE_URL = "http://localhost:9000";
const EXPECTED_SUBTOTAL = 7294.4;
const EXPECTED_DISCOUNT = 875.33;
const EXPECTED_TOTAL = 6419.07;
const EPSILON = 0.05;

function forgeAdminToken(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing");
  return jwt.sign(
    {
      actor_id: ADMIN_USER_ID,
      actor_type: "user",
      auth_identity_id: ADMIN_USER_ID,
      app_metadata: { user_id: ADMIN_USER_ID },
    },
    secret,
    { expiresIn: "1h" }
  );
}

interface Snapshot {
  adjustments: any[];
  promoLinks: any[];
  taxLines: any[];
  orderMetadata: any;
}

async function snapshot(client: Client): Promise<Snapshot> {
  const adj = await client.query(
    `SELECT * FROM order_line_item_adjustment
     WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)`,
    [TARGET_ORDER]
  );
  const promo = await client.query(
    `SELECT * FROM order_promotion WHERE order_id = $1`,
    [TARGET_ORDER]
  );
  const tax = await client.query(
    `SELECT * FROM order_line_item_tax_line
     WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)`,
    [TARGET_ORDER]
  );
  const md = await client.query(
    `SELECT metadata FROM "order" WHERE id = $1`,
    [TARGET_ORDER]
  );
  return {
    adjustments: adj.rows,
    promoLinks: promo.rows,
    taxLines: tax.rows,
    orderMetadata: md.rows[0]?.metadata ?? {},
  };
}

async function wipeAdjustmentsOnly(client: Client) {
  await client.query(
    `DELETE FROM order_line_item_adjustment
     WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)`,
    [TARGET_ORDER]
  );
  await client.query(
    `DELETE FROM order_promotion WHERE order_id = $1`,
    [TARGET_ORDER]
  );
}

async function restore(client: Client, snap: Snapshot) {
  await client.query(
    `DELETE FROM order_line_item_adjustment
     WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)`,
    [TARGET_ORDER]
  );
  await client.query(
    `DELETE FROM order_promotion WHERE order_id = $1`,
    [TARGET_ORDER]
  );
  await client.query(
    `DELETE FROM order_line_item_tax_line
     WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)`,
    [TARGET_ORDER]
  );

  // Sync the snapshot's version to whatever the order_item table is at NOW.
  // apply-discount-force bumps order_item.version, so restoring with the
  // original (older) version would leave adjustments invisible to Medusa.
  const verRes = await client.query<{ v: string | null }>(
    `SELECT MAX(version)::text AS v FROM order_item WHERE order_id = $1 AND deleted_at IS NULL`,
    [TARGET_ORDER]
  );
  const currentVersion = Number(verRes.rows[0]?.v ?? 1);

  for (const r of snap.adjustments) {
    const adjId = `${r.id}_v${currentVersion}`;
    await client.query(
      `INSERT INTO order_line_item_adjustment
         (id, description, promotion_id, code, amount, raw_amount, provider_id, created_at, updated_at, item_id, deleted_at, is_tax_inclusive, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING`,
      [
        adjId,
        r.description,
        r.promotion_id,
        r.code,
        r.amount,
        r.raw_amount,
        r.provider_id,
        r.created_at,
        r.updated_at,
        r.item_id,
        r.deleted_at,
        r.is_tax_inclusive,
        currentVersion,
      ]
    );
  }
  for (const r of snap.promoLinks) {
    await client.query(
      `INSERT INTO order_promotion (order_id, promotion_id, id, created_at, updated_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (order_id, promotion_id) DO NOTHING`,
      [r.order_id, r.promotion_id, r.id, r.created_at, r.updated_at, r.deleted_at]
    );
  }
  for (const r of snap.taxLines) {
    await client.query(
      `INSERT INTO order_line_item_tax_line
         (id, description, tax_rate_id, code, rate, raw_rate, provider_id, created_at, updated_at, item_id, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [
        r.id,
        r.description,
        r.tax_rate_id,
        r.code,
        r.rate,
        r.raw_rate,
        r.provider_id,
        r.created_at,
        r.updated_at,
        r.item_id,
        r.deleted_at,
      ]
    );
  }
  await client.query(`UPDATE "order" SET metadata = $1 WHERE id = $2`, [
    snap.orderMetadata,
    TARGET_ORDER,
  ]);
  // Cancel any zombie order_change left by a failed test run
  await client.query(
    `UPDATE order_change SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
     WHERE order_id = $1 AND status = 'pending' AND deleted_at IS NULL`,
    [TARGET_ORDER]
  );
}

interface DbState {
  adjCount: number;
  adjSum: number;
  promoLinks: number;
  zombieChanges: number;
}

async function readState(client: Client): Promise<DbState> {
  const adj = await client.query<{ c: string; s: string | null }>(
    `SELECT count(*)::text AS c, COALESCE(sum(amount),0)::text AS s
     FROM order_line_item_adjustment a
     JOIN order_item oi ON oi.item_id = a.item_id
     WHERE oi.order_id = $1 AND a.deleted_at IS NULL`,
    [TARGET_ORDER]
  );
  const promo = await client.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM order_promotion WHERE order_id = $1 AND deleted_at IS NULL`,
    [TARGET_ORDER]
  );
  const zombie = await client.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM order_change
     WHERE order_id = $1 AND status = 'pending' AND deleted_at IS NULL`,
    [TARGET_ORDER]
  );
  return {
    adjCount: Number(adj.rows[0]?.c ?? 0),
    adjSum: Number(adj.rows[0]?.s ?? 0),
    promoLinks: Number(promo.rows[0]?.c ?? 0),
    zombieChanges: Number(zombie.rows[0]?.c ?? 0),
  };
}

async function callPostEditSync(token: string, body: any) {
  const res = await fetch(
    `${BASE_URL}/admin/orders/${TARGET_ORDER}/post-edit-sync`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

interface Case {
  name: string;
  prepare?: (client: Client) => Promise<void>;
  body: any;
  expect: (s: DbState) => string | null; // null = pass, string = failure reason
}

const CASES: Case[] = [
  {
    name: "1. Save healthy order with same 12% promo (no-op success)",
    body: {
      promotion_code: "CPOS-PCT-1200",
      discount_type: "percent",
      discount_value: 12,
      pos_discount_amount: EXPECTED_DISCOUNT,
      pos_total: EXPECTED_TOTAL,
      pos_tax_amount: 0,
      pos_tax_rate: 0,
      skip_qb: true,
    },
    expect: (s) => {
      if (s.adjCount !== 7) return `adjCount=${s.adjCount} (expected 7)`;
      if (Math.abs(s.adjSum - EXPECTED_DISCOUNT) > EPSILON)
        return `adjSum=${s.adjSum} (expected ${EXPECTED_DISCOUNT})`;
      if (s.promoLinks < 1) return `promoLinks=${s.promoLinks} (expected ≥1)`;
      if (s.zombieChanges > 0)
        return `zombieChanges=${s.zombieChanges} (expected 0)`;
      return null;
    },
  },
  {
    name: "2. Orphan recovery — adjustments wiped, save still has discount",
    prepare: wipeAdjustmentsOnly,
    body: {
      promotion_code: "CPOS-PCT-1200",
      discount_type: "percent",
      discount_value: 12,
      pos_discount_amount: EXPECTED_DISCOUNT,
      pos_total: EXPECTED_TOTAL,
      pos_tax_amount: 0,
      pos_tax_rate: 0,
      skip_qb: true,
    },
    expect: (s) => {
      if (s.adjCount !== 7) return `adjCount=${s.adjCount} (expected 7)`;
      if (Math.abs(s.adjSum - EXPECTED_DISCOUNT) > EPSILON)
        return `adjSum=${s.adjSum} (expected ${EXPECTED_DISCOUNT})`;
      if (s.zombieChanges > 0)
        return `zombieChanges=${s.zombieChanges} (expected 0)`;
      return null;
    },
  },
  {
    name: "3. Remove discount — pos_discount_amount=0 deletes adjustments",
    body: {
      pos_discount_amount: 0,
      pos_total: EXPECTED_SUBTOTAL,
      pos_tax_amount: 0,
      pos_tax_rate: 0,
      skip_qb: true,
    },
    expect: (s) => {
      if (s.adjCount !== 0) return `adjCount=${s.adjCount} (expected 0)`;
      if (s.zombieChanges > 0)
        return `zombieChanges=${s.zombieChanges} (expected 0)`;
      return null;
    },
  },
  {
    name: "4. Save without any discount fields — adjustments untouched",
    body: {
      pos_total: EXPECTED_TOTAL,
      pos_tax_amount: 0,
      pos_tax_rate: 0,
      skip_qb: true,
    },
    expect: (s) => {
      if (s.adjCount !== 7) return `adjCount=${s.adjCount} (expected 7)`;
      if (Math.abs(s.adjSum - EXPECTED_DISCOUNT) > EPSILON)
        return `adjSum=${s.adjSum} (expected ${EXPECTED_DISCOUNT} unchanged)`;
      return null;
    },
  },
  {
    name: "5. Switch to fixed $200 discount — apply-discount-force creates new adjustments",
    body: {
      discount_type: "fixed",
      discount_value: 200,
      pos_discount_amount: 200,
      pos_total: EXPECTED_SUBTOTAL - 200,
      pos_tax_amount: 0,
      pos_tax_rate: 0,
      skip_qb: true,
    },
    expect: (s) => {
      if (s.adjCount === 0) return `adjCount=0 (expected ≥1)`;
      if (Math.abs(s.adjSum - 200) > EPSILON)
        return `adjSum=${s.adjSum} (expected 200)`;
      if (s.zombieChanges > 0)
        return `zombieChanges=${s.zombieChanges} (expected 0)`;
      return null;
    },
  },
  {
    name: "6. Apply 5% with orphan precondition — recovery + new promo work together",
    prepare: wipeAdjustmentsOnly,
    body: {
      discount_type: "percent",
      discount_value: 5,
      pos_discount_amount: EXPECTED_SUBTOTAL * 0.05,
      pos_total: EXPECTED_SUBTOTAL * 0.95,
      pos_tax_amount: 0,
      pos_tax_rate: 0,
      skip_qb: true,
    },
    expect: (s) => {
      if (s.adjCount === 0) return `adjCount=0 (expected ≥1)`;
      const expected = EXPECTED_SUBTOTAL * 0.05;
      if (Math.abs(s.adjSum - expected) > EPSILON)
        return `adjSum=${s.adjSum.toFixed(2)} (expected ${expected.toFixed(2)})`;
      return null;
    },
  },
];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const token = forgeAdminToken();

  console.log(`🔬 Discount save-scenario harness on S1350`);
  console.log(`   token len=${token.length}, base=${BASE_URL}`);
  console.log("");

  const initialSnap = await snapshot(client);
  console.log(
    `   Initial snapshot: ${initialSnap.adjustments.length} adj, ${initialSnap.promoLinks.length} promo, ${initialSnap.taxLines.length} tax\n`
  );

  let passed = 0;
  let failed = 0;
  const failures: { name: string; reason: string }[] = [];

  for (const c of CASES) {
    process.stdout.write(`   ${c.name} ... `);
    try {
      if (c.prepare) await c.prepare(client);
      const { status, json } = await callPostEditSync(token, c.body);
      if (status >= 400) {
        process.stdout.write(`HTTP ${status}\n`);
        failures.push({
          name: c.name,
          reason: `HTTP ${status}: ${JSON.stringify(json).slice(0, 200)}`,
        });
        failed++;
        await restore(client, initialSnap);
        continue;
      }
      const state = await readState(client);
      const reason = c.expect(state);
      if (reason) {
        process.stdout.write(`FAIL — ${reason}\n`);
        failed++;
        failures.push({ name: c.name, reason });
      } else {
        process.stdout.write(
          `PASS  (adj=${state.adjCount}, sum=$${state.adjSum.toFixed(2)})\n`
        );
        passed++;
      }
    } catch (e: any) {
      process.stdout.write(`THROW — ${e?.message ?? e}\n`);
      failed++;
      failures.push({ name: c.name, reason: e?.message ?? String(e) });
    } finally {
      await restore(client, initialSnap);
    }
  }

  console.log("");
  console.log(`📊 Result: ${passed}/${CASES.length} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("");
    console.log("Failures:");
    for (const f of failures) console.log(`   - ${f.name}: ${f.reason}`);
  }

  // Final restore (already done in finally, but be paranoid)
  await restore(client, initialSnap);
  const finalState = await readState(client);
  console.log(
    `\n🧹 Final state of S1350: adj=${finalState.adjCount}, sum=$${finalState.adjSum.toFixed(2)}, promo=${finalState.promoLinks}, zombies=${finalState.zombieChanges}`
  );

  await client.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
