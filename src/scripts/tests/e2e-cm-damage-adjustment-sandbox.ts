/**
 * e2e-cm-damage-adjustment-sandbox
 *
 * Prueba de punta a punta, contra Postgres REAL, de la máquina de estados que
 * decide qué le pasa al InventoryAdjustment de defectuosos de un credit memo.
 *
 * POR QUÉ EXISTE
 * El verificador estático (`verify-cm-damage-adjustment.ts`) audita que el
 * cableado esté puesto; no ejecuta una sola línea de decisión. Y los unit tests
 * de este repo pasan pools falsos, así que el SQL nunca corre bajo ellos — un
 * cast `uuid = text` mal puesto ya dejó un gate silenciosamente apagado en
 * producción, en verde. Acá el SQL corre.
 *
 * LA INVARIANTE QUE MÁS IMPORTA
 * Un credit memo posee UN ajuste durante toda su vida. La forma de romperlo no
 * es un error: es un SEGUNDO documento en QuickBooks, que nadie ve hasta que el
 * inventario no cierra. Por eso casi todos los asserts terminan contando cuántas
 * filas de ADD existen — nunca puede haber dos.
 *
 * QUÉ NO PRUEBA
 * En sandbox el bridge de QuickBooks está apagado, así que esto verifica el
 * PAYLOAD encolado y las transiciones, no el documento en QuickBooks. Esa mitad
 * la contestó el experimento controlado del 2026-08-12 contra QB de producción
 * (QuantityDifference FIJA, TxnLineID -1 agrega, omitir borra).
 *
 * SEGURIDAD
 * Se niega a correr si DATABASE_URL no apunta al Postgres del sandbox (5499).
 * Todo fixture lleva el prefijo `e2edmg_`, se borra en un finally, y el script
 * comprueba que la limpieza realmente ocurrió.
 *
 * Correr (sandbox arriba):
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-cm-damage-adjustment-sandbox.ts
 */
import { Client } from "pg";

import {
  syncCreditMemoDamageAdjustment,
  DAMAGE_ACCOUNT_ENV,
} from "../../lib/quickbooks/damage/sync-damage-adjustment";

const PREFIX = "e2edmg_";
const CM_ID = `${PREFIX}cm`;
const CM_NUMBER = "CM-9901";
const FAKE_ACCOUNT = "8000007C-1369921760";
const FAKE_TXN = "1CCFAKE-1786000000";

let failures = 0;
const assert = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const logger = {
  info: () => {},
  warn: (m: string) => console.log(`   ⚠ ${m}`),
  error: (m: string) => console.log(`   ✖ ${m}`),
};

type Variant = { id: string; sku: string };

async function pickVariants(client: Client): Promise<{
  inv: Variant[];
  service: Variant | null;
}> {
  const { rows: inv } = await client.query(
    `SELECT pv.id, pv.sku
       FROM product_variant pv
      WHERE pv.deleted_at IS NULL
        AND pv.sku IS NOT NULL
        AND pv.metadata->>'quickbooks_id' IS NOT NULL
        AND COALESCE(pv.metadata->>'qb_item_type', 'Inventory') NOT IN
            ('Service','NonInventory','NonInventoryPart','OtherCharge','Discount')
      ORDER BY pv.id
      LIMIT 3`
  );
  const { rows: svc } = await client.query(
    `SELECT pv.id, pv.sku
       FROM product_variant pv
       LEFT JOIN product p ON p.id = pv.product_id
      WHERE pv.deleted_at IS NULL
        AND pv.sku IS NOT NULL
        AND (pv.metadata->>'qb_item_type' IN ('Service','NonInventory','OtherCharge')
             OR p.metadata->>'qb_item_type' IN ('Service','NonInventory','OtherCharge')
             OR pv.metadata->>'quickbooks_is_service' = 'true'
             OR p.metadata->>'quickbooks_is_service' = 'true')
      LIMIT 1`
  );
  return { inv, service: svc[0] ?? null };
}

/** Reescribe las líneas del credit memo — cada escenario define su estado. */
async function setLines(
  client: Client,
  lines: Array<{ variant: Variant | null; qty: number; damaged: number }>
): Promise<void> {
  await client.query(`DELETE FROM pos_credit_memo_item WHERE credit_memo_id = $1`, [
    CM_ID,
  ]);
  let i = 0;
  for (const l of lines) {
    await client.query(
      `INSERT INTO pos_credit_memo_item
         (id, credit_memo_id, variant_id, sku, description, quantity, damaged_qty,
          unit_price, raw_unit_price, line_total, raw_line_total, sort_order,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'e2e', $5, $6,
               100, '{"value":"100","precision":20}'::jsonb,
               100, '{"value":"100","precision":20}'::jsonb, $7, NOW(), NOW())`,
      [
        `${PREFIX}item_${i}`,
        CM_ID,
        l.variant?.id ?? null,
        l.variant?.sku ?? null,
        l.qty,
        l.damaged,
        i,
      ]
    );
    i += 1;
  }
}

async function rowsFor(
  client: Client,
  step: string
): Promise<Array<Record<string, any>>> {
  const { rows } = await client.query(
    `SELECT id, step, status, qb_txn_id, payload, medusa_ref_number
       FROM qb_order_pipeline
      WHERE reference_id = $1 AND step = $2
      ORDER BY created_at`,
    [CM_ID, step]
  );
  return rows;
}

async function clearRows(client: Client): Promise<void> {
  await client.query(`DELETE FROM qb_order_pipeline WHERE reference_id = $1`, [
    CM_ID,
  ]);
}

async function setAdjustmentPointer(
  client: Client,
  txnId: string | null
): Promise<void> {
  await client.query(
    // $2 va casteado a text en las DOS apariciones: dentro de un CASE, Postgres
    // no puede inferir el tipo de un parámetro que se compara contra NULL y
    // rechaza la sentencia entera con "could not determine data type".
    `UPDATE pos_credit_memo
        SET qb_inventory_adjustment_txn_id = $2::text,
            qb_inventory_adjustment_edit_sequence =
              CASE WHEN $2::text IS NULL THEN NULL ELSE '1786000000' END
      WHERE id = $1`,
    [CM_ID, txnId]
  );
}

/** damaged_qty por SKU dentro del payload encolado. */
function payloadDamage(row: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of row?.payload?.lines ?? []) out[l.sku] = l.damaged_qty;
  return out;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("5499")) {
    console.error(
      `❌ Este E2E sólo corre contra el Postgres del sandbox (5499). DATABASE_URL=${url.slice(0, 40)}…`
    );
    process.exit(2);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  const originalAccount = process.env[DAMAGE_ACCOUNT_ENV];

  try {
    const { inv, service } = await pickVariants(client);
    if (inv.length < 2) {
      console.error("❌ El sandbox no tiene 2 variantes de inventario con quickbooks_id");
      process.exit(2);
    }
    const [A, B] = inv;
    console.log(`\nFixtures: A=${A.sku}  B=${B.sku}  servicio=${service?.sku ?? "(ninguno)"}\n`);

    await client.query(`DELETE FROM qb_order_pipeline WHERE reference_id = $1`, [CM_ID]);
    await client.query(`DELETE FROM pos_credit_memo_item WHERE credit_memo_id = $1`, [CM_ID]);
    await client.query(`DELETE FROM pos_credit_memo WHERE id = $1`, [CM_ID]);
    await client.query(
      `INSERT INTO pos_credit_memo
         (id, credit_memo_number, status, subtotal, raw_subtotal, discount, raw_discount,
          tax, raw_tax, total, raw_total, created_at, updated_at)
       VALUES ($1, $2, 'completed',
               0,'{"value":"0","precision":20}'::jsonb,
               0,'{"value":"0","precision":20}'::jsonb,
               0,'{"value":"0","precision":20}'::jsonb,
               0,'{"value":"0","precision":20}'::jsonb, NOW(), NOW())`,
      [CM_ID, CM_NUMBER]
    );

    // ── 1. Control negativo: sin la env var no se emite NADA ────────────────
    console.log("── 1. Fail-closed sin cuenta configurada ──");
    delete process.env[DAMAGE_ACCOUNT_ENV];
    await setLines(client, [{ variant: A, qty: 2, damaged: 1 }]);
    let out = await syncCreditMemoDamageAdjustment({
      creditMemoId: CM_ID,
      reason: "complete",
      logger,
    });
    assert(out.action === "none", "sin env var no encola nada", out.reason);
    assert(
      (await rowsFor(client, "cm_damage_adjustment")).length === 0,
      "cero filas de pipeline con el mecanismo apagado"
    );

    // ── 2. Control POSITIVO: con la cuenta, sí encola ───────────────────────
    // Sin este control el test de arriba es vacuo: "cero filas" también pasa si
    // el mecanismo estuviera roto por cualquier otro motivo.
    console.log("\n── 2. Complete: return 2 / defective 1 → ADD ──");
    process.env[DAMAGE_ACCOUNT_ENV] = FAKE_ACCOUNT;
    out = await syncCreditMemoDamageAdjustment({
      creditMemoId: CM_ID,
      reason: "complete",
      logger,
    });
    assert(out.action === "add", "primer defectuoso encola un ADD", out.action);
    let adds = await rowsFor(client, "cm_damage_adjustment");
    assert(adds.length === 1, "exactamente UNA fila de ADD", `hay ${adds.length}`);
    assert(
      JSON.stringify(payloadDamage(adds[0])) === JSON.stringify({ [A.sku]: 1 }),
      "el payload pide 1 unidad defectuosa de A",
      JSON.stringify(payloadDamage(adds[0]))
    );
    assert(
      adds[0].payload.ref_number === "DMG9901",
      "el ref se deriva del credit memo",
      adds[0].payload.ref_number
    );
    assert(
      adds[0].payload.memo === "CM-9901 defective products",
      "el memo nombra el credit memo",
      adds[0].payload.memo
    );

    // Simula el confirm del ADD: el credit memo ya conoce su ajuste.
    await setAdjustmentPointer(client, FAKE_TXN);

    // ── 3. Cambia SÓLO la cantidad devuelta ────────────────────────────────
    console.log("\n── 3. Edit: cambia la cantidad devuelta, defectuosos iguales ──");
    await setLines(client, [{ variant: A, qty: 3, damaged: 1 }]);
    out = await syncCreditMemoDamageAdjustment({
      creditMemoId: CM_ID,
      reason: "edit",
      logger,
    });
    assert(out.action === "mod", "va por MOD, jamás por un segundo ADD", out.action);
    assert(
      (await rowsFor(client, "cm_damage_adjustment")).length === 1,
      "sigue habiendo UNA sola fila de ADD"
    );
    let mods = await rowsFor(client, "cm_damage_adjustment_mod");
    assert(mods.length === 1 && mods[0].qb_txn_id === FAKE_TXN, "el MOD apunta al ajuste existente");
    assert(
      JSON.stringify(payloadDamage(mods[0])) === JSON.stringify({ [A.sku]: 1 }),
      "el defectuoso NO cambió (el credit_memo_mod ya ajusta lo que QB restockea)",
      JSON.stringify(payloadDamage(mods[0]))
    );

    // ── 4. Cambia SÓLO el defectuoso ───────────────────────────────────────
    console.log("\n── 4. Edit: defectuosos 1 → 2 ──");
    await setLines(client, [{ variant: A, qty: 3, damaged: 2 }]);
    await syncCreditMemoDamageAdjustment({ creditMemoId: CM_ID, reason: "damaged_edit", logger });
    mods = await rowsFor(client, "cm_damage_adjustment_mod");
    assert(
      JSON.stringify(payloadDamage(mods[0])) === JSON.stringify({ [A.sku]: 2 }),
      "el MOD pide 2 unidades",
      JSON.stringify(payloadDamage(mods[0]))
    );

    // ── 5. Cambian AMBAS ───────────────────────────────────────────────────
    console.log("\n── 5. Edit: cambian cantidad Y defectuosos ──");
    await setLines(client, [{ variant: A, qty: 1, damaged: 1 }]);
    await syncCreditMemoDamageAdjustment({ creditMemoId: CM_ID, reason: "edit", logger });
    mods = await rowsFor(client, "cm_damage_adjustment_mod");
    assert(
      JSON.stringify(payloadDamage(mods[0])) === JSON.stringify({ [A.sku]: 1 }),
      "el MOD refleja el estado nuevo",
      JSON.stringify(payloadDamage(mods[0]))
    );

    // ── 6. Clamp: defectuoso mayor que lo devuelto ─────────────────────────
    console.log("\n── 6. Clamp: damaged > quantity ──");
    await setLines(client, [{ variant: A, qty: 2, damaged: 5 }]);
    await syncCreditMemoDamageAdjustment({ creditMemoId: CM_ID, reason: "edit", logger });
    mods = await rowsFor(client, "cm_damage_adjustment_mod");
    assert(
      payloadDamage(mods[0])[A.sku] === 2,
      "nunca se escriben a pérdida más unidades de las devueltas",
      String(payloadDamage(mods[0])[A.sku])
    );

    // ── 7. Multi-SKU + SKU repetido ────────────────────────────────────────
    console.log("\n── 7. Multi-SKU mixto, con A repetido en dos líneas ──");
    await setLines(client, [
      { variant: A, qty: 2, damaged: 1 },
      { variant: A, qty: 2, damaged: 1 },
      { variant: B, qty: 3, damaged: 0 },
    ]);
    await syncCreditMemoDamageAdjustment({ creditMemoId: CM_ID, reason: "edit", logger });
    mods = await rowsFor(client, "cm_damage_adjustment_mod");
    const multi = payloadDamage(mods[0]);
    assert(multi[A.sku] === 2, "las dos líneas del mismo SKU se agregan", JSON.stringify(multi));
    assert(!(B.sku in multi), "un SKU sin defectuosos no entra en el ajuste");

    // ── 8. Un SKU baja a 0 pero quedan otros → sigue siendo MOD ────────────
    console.log("\n── 8. Un SKU se cae, quedan otros ──");
    await setLines(client, [
      { variant: A, qty: 2, damaged: 0 },
      { variant: B, qty: 3, damaged: 1 },
    ]);
    out = await syncCreditMemoDamageAdjustment({ creditMemoId: CM_ID, reason: "edit", logger });
    assert(out.action === "mod", "sigue siendo un MOD, no un void", out.action);
    mods = await rowsFor(client, "cm_damage_adjustment_mod");
    const only = payloadDamage(mods[0]);
    assert(
      !(A.sku in only) && only[B.sku] === 1,
      "A desaparece del payload (QuickBooks borra la línea por omisión)",
      JSON.stringify(only)
    );

    // ── 9. TODOS a 0 → VOID ────────────────────────────────────────────────
    console.log("\n── 9. Todos los defectuosos a 0 → VOID ──");
    await setLines(client, [
      { variant: A, qty: 2, damaged: 0 },
      { variant: B, qty: 3, damaged: 0 },
    ]);
    out = await syncCreditMemoDamageAdjustment({ creditMemoId: CM_ID, reason: "damaged_edit", logger });
    assert(out.action === "void", "sin defectuosos vivos se retira el ajuste", out.action);
    const voids = await rowsFor(client, "void_cm_damage_adjustment");
    assert(
      voids.length === 1 && voids[0].qb_txn_id === FAKE_TXN,
      "el void apunta al ajuste correcto"
    );

    // ── 10. Tras el void, un defectuoso nuevo crea un ajuste NUEVO ─────────
    console.log("\n── 10. Post-void: vuelve a haber defectuosos ──");
    await setAdjustmentPointer(client, null); // el poller libera el puntero al confirmar
    await clearRows(client);
    await setLines(client, [{ variant: A, qty: 2, damaged: 1 }]);
    out = await syncCreditMemoDamageAdjustment({ creditMemoId: CM_ID, reason: "damaged_edit", logger });
    assert(out.action === "add", "con el puntero liberado nace un ajuste nuevo", out.action);

    // ── 10b. Los defectuosos vuelven ANTES de que el void despache ─────────
    // La ventana real: bajar a 0, mirar, corregir. Segundos. El puntero todavía
    // está puesto porque el void no confirmó, así que sin tratamiento propio
    // esto encolaba un MOD contra un documento en camino de desaparecer.
    console.log("\n── 10b. Vuelven los defectuosos con el void TODAVÍA EN COLA ──");
    await clearRows(client);
    await setAdjustmentPointer(client, FAKE_TXN);
    await setLines(client, [{ variant: A, qty: 2, damaged: 0 }]);
    await syncCreditMemoDamageAdjustment({ creditMemoId: CM_ID, reason: "damaged_edit", logger });
    let vrows = await rowsFor(client, "void_cm_damage_adjustment");
    assert(vrows.length === 1 && vrows[0].status === "pending", "el void quedó encolado");

    await setLines(client, [{ variant: A, qty: 2, damaged: 1 }]);
    out = await syncCreditMemoDamageAdjustment({ creditMemoId: CM_ID, reason: "damaged_edit", logger });
    assert(out.action === "mod", "se edita el MISMO ajuste, no se crea otro", out.action);
    vrows = await rowsFor(client, "void_cm_damage_adjustment");
    assert(
      vrows[0].status === "skipped",
      "el void sin despachar se CANCELA — no se voidea un documento para recrearlo igual",
      vrows[0].status
    );

    // ── 10c. Los defectuosos vuelven con el void YA DESPACHADO ─────────────
    console.log("\n── 10c. Vuelven los defectuosos con el void YA DESPACHADO ──");
    await clearRows(client);
    await setAdjustmentPointer(client, FAKE_TXN);
    await client.query(
      `INSERT INTO qb_order_pipeline (order_id, reference_id, reference_type, step, status, qb_txn_id)
       VALUES (NULL, $1, 'credit_memo', $2, 'submitted', $3)`,
      [CM_ID, "void_cm_damage_adjustment", FAKE_TXN]
    );
    await setLines(client, [{ variant: A, qty: 2, damaged: 1 }]);
    out = await syncCreditMemoDamageAdjustment({ creditMemoId: CM_ID, reason: "damaged_edit", logger });
    assert(
      out.action === "add",
      "con el void ya en vuelo, el ajuste está muerto → nace uno nuevo",
      out.action
    );
    assert(
      (await rowsFor(client, "cm_damage_adjustment_mod")).length === 0,
      "no se encola un MOD contra el documento que se está voideando"
    );

    // ── 11. Void del credit memo ───────────────────────────────────────────
    console.log("\n── 11. Void del credit memo (forceEmpty) ──");
    await setAdjustmentPointer(client, FAKE_TXN);
    await clearRows(client);
    out = await syncCreditMemoDamageAdjustment({
      creditMemoId: CM_ID,
      reason: "void",
      logger,
      forceEmpty: true,
    });
    assert(
      out.action === "void",
      "con forceEmpty se retira el ajuste aunque las líneas sigan con defectuosos",
      out.action
    );
    assert(
      (await rowsFor(client, "cm_damage_adjustment_mod")).length === 0,
      "no se encola ningún MOD en el camino de void"
    );

    // ── 12. Líneas que no se pueden ajustar ────────────────────────────────
    console.log("\n── 12. Líneas sin variante y de servicio ──");
    await setAdjustmentPointer(client, null);
    await clearRows(client);
    const weird: Array<{ variant: Variant | null; qty: number; damaged: number }> = [
      { variant: A, qty: 2, damaged: 1 },
      { variant: null, qty: 1, damaged: 1 },
    ];
    if (service) weird.push({ variant: service, qty: 1, damaged: 1 });
    await setLines(client, weird);
    out = await syncCreditMemoDamageAdjustment({ creditMemoId: CM_ID, reason: "edit", logger });
    adds = await rowsFor(client, "cm_damage_adjustment");
    const finalDamage = payloadDamage(adds[0]);
    assert(
      Object.keys(finalDamage).length === 1 && finalDamage[A.sku] === 1,
      "sólo la línea de inventario entra al ajuste",
      JSON.stringify(finalDamage)
    );
    assert(
      (out.skipped ?? []).length >= 1,
      "las líneas no ajustables se REPORTAN, no se ocultan",
      JSON.stringify(out.skipped)
    );
  } finally {
    if (originalAccount === undefined) delete process.env[DAMAGE_ACCOUNT_ENV];
    else process.env[DAMAGE_ACCOUNT_ENV] = originalAccount;

    await client.query(`DELETE FROM qb_order_pipeline WHERE reference_id = $1`, [CM_ID]);
    await client.query(`DELETE FROM pos_credit_memo_item WHERE credit_memo_id = $1`, [CM_ID]);
    await client.query(`DELETE FROM pos_credit_memo WHERE id = $1`, [CM_ID]);

    const { rows: leftovers } = await client.query(
      `SELECT (SELECT count(*) FROM pos_credit_memo WHERE id LIKE $1)
            + (SELECT count(*) FROM pos_credit_memo_item WHERE id LIKE $1)
            + (SELECT count(*) FROM qb_order_pipeline WHERE reference_id LIKE $1) AS n`,
      [`${PREFIX}%`]
    );
    assert(Number(leftovers[0].n) === 0, "limpieza completa de fixtures", `quedaron ${leftovers[0].n}`);
    await client.end();
  }

  console.log(
    failures === 0
      ? "\n✅ PASS — la máquina de estados del ajuste de defectuosos se comporta\n"
      : `\n❌ FAIL — ${failures} assert(s)\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("❌ E2E crasheó:", e);
  process.exit(1);
});
