import knexFactory from "knex";

import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
  type PurchaseQbStep,
} from "../../lib/purchase-orders/qb-purchase-dependency-chain";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (
  process.env.ECOPOWERTECH_ENV !== "sandbox" ||
  !databaseUrl.includes("localhost:5499")
) {
  throw new Error("Refusing to run outside the local sandbox (localhost:5499)");
}

const db = knexFactory({
  client: "pg",
  connection: databaseUrl,
  pool: { min: 0, max: 12 },
});
const runId = `verify_purchase_chain_${Date.now()}`;
const poIds = [
  `${runId}_increase`,
  `${runId}_reduction`,
  `${runId}_concurrent`,
  `${runId}_nested`,
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function enqueue(
  poId: string,
  step: PurchaseQbStep,
  referenceId: string,
  revision: string
) {
  const payload = {
    verify_run_id: runId,
    operation_revision: revision,
  };
  return enqueuePurchaseQbOperation(db, {
    purchaseOrderId: poId,
    referenceId,
    referenceType:
      step === "purchase_order_mod"
        ? "purchase_order"
        : step.startsWith("item_receipt")
          ? "item_receipt"
          : "vendor_bill",
    step,
    payload,
    operationKey: purchaseOperationKey(step, referenceId, payload),
  });
}

async function verifyOrderedChain(
  poId: string,
  operations: Array<{
    step: PurchaseQbStep;
    referenceId: string;
    revision: string;
  }>
) {
  const inserted = [];
  for (const operation of operations) {
    inserted.push(
      await enqueue(
        poId,
        operation.step,
        operation.referenceId,
        operation.revision
      )
    );
  }
  assert(inserted[0]?.status === "pending", `${poId}: first row not pending`);
  for (let index = 1; index < inserted.length; index++) {
    assert(
      inserted[index]?.status === "waiting",
      `${poId}: child ${index} not waiting: ${JSON.stringify(inserted)}`
    );
    assert(
      inserted[index]?.dependsOn === inserted[index - 1]?.id,
      `${poId}: child ${index} does not depend on its immediate parent`
    );
  }
  return inserted;
}

async function main() {
  try {
    const increase = await verifyOrderedChain(poIds[0], [
      {
        step: "purchase_order_mod",
        referenceId: poIds[0],
        revision: "po-increase",
      },
      {
        step: "item_receipt_mod",
        referenceId: `${poIds[0]}_receipt`,
        revision: "receipt-increase",
      },
      {
        step: "vendor_bill_mod",
        referenceId: `${poIds[0]}_bill`,
        revision: "bill-increase",
      },
    ]);

    const reduction = await verifyOrderedChain(poIds[1], [
      {
        step: "vendor_bill_mod",
        referenceId: `${poIds[1]}_bill`,
        revision: "bill-reduction",
      },
      {
        step: "item_receipt_mod",
        referenceId: `${poIds[1]}_receipt`,
        revision: "receipt-reduction",
      },
      {
        step: "purchase_order_mod",
        referenceId: poIds[1],
        revision: "po-reduction",
      },
    ]);

    const duplicate = await enqueue(
      poIds[1],
      "purchase_order_mod",
      poIds[1],
      "po-reduction"
    );
    assert(duplicate.reused, "identical operation was not reused");
    assert(
      duplicate.id === reduction[2]?.id,
      "identical operation changed the chain tail"
    );

    await db.raw(
      `UPDATE qb_order_pipeline
          SET status = 'failed', next_retry_at = NULL
        WHERE id = ?`,
      [increase[0]?.id]
    );
    await db.raw(
      `UPDATE qb_order_pipeline child
          SET error = 'Blocked by failed dependency ' || parent.id::text
         FROM qb_order_pipeline parent
        WHERE child.depends_on = parent.id
          AND child.status = 'waiting'
          AND parent.status = 'failed'
          AND parent.next_retry_at IS NULL`
    );
    const blocked = await db.raw(
      `SELECT status, error FROM qb_order_pipeline WHERE id = ?`,
      [increase[1]?.id]
    );
    assert(
      blocked.rows[0]?.status === "waiting",
      "blocked child was dispatched"
    );
    assert(
      String(blocked.rows[0]?.error ?? "").includes("Blocked by failed"),
      "blocked child has no visible parent error"
    );

    await db.raw(`UPDATE qb_order_pipeline SET status = 'fixed' WHERE id = ?`, [
      increase[0]?.id,
    ]);
    await db.raw(
      `UPDATE qb_order_pipeline child
          SET status = 'pending', error = NULL
         FROM qb_order_pipeline parent
        WHERE child.depends_on = parent.id
          AND child.status = 'waiting'
          AND parent.status IN ('confirmed', 'fixed')`
    );
    const awakened = await db.raw(
      `SELECT status FROM qb_order_pipeline WHERE id = ?`,
      [increase[1]?.id]
    );
    assert(
      awakened.rows[0]?.status === "pending",
      "fixed parent did not make its child eligible"
    );

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        enqueue(
          poIds[2],
          "item_receipt_mod",
          `${poIds[2]}_receipt_${index}`,
          `concurrent-${index}`
        )
      )
    );
    assert(
      new Set(concurrent.map((operation) => operation.id)).size === 8,
      "concurrent operations were lost or deduplicated incorrectly"
    );
    const concurrentRows = await db.raw(
      `SELECT id, depends_on, status
         FROM qb_order_pipeline
        WHERE order_id = ?
          AND payload->>'verify_run_id' = ?`,
      [poIds[2], runId]
    );
    const roots = concurrentRows.rows.filter(
      (row: { depends_on: string | null }) => row.depends_on === null
    );
    const parentIds = concurrentRows.rows
      .map((row: { depends_on: string | null }) => row.depends_on)
      .filter(Boolean);
    assert(concurrentRows.rows.length === 8, "concurrent chain lost rows");
    assert(roots.length === 1, "concurrent enqueue created multiple roots");
    assert(
      new Set(parentIds).size === 7,
      "concurrent enqueue created sibling branches"
    );

    const outer = await db.transaction();
    try {
      const payload = {
        verify_run_id: runId,
        operation_revision: "nested-transaction",
      };
      const nested = await enqueuePurchaseQbOperation(outer, {
        purchaseOrderId: poIds[3],
        referenceId: poIds[3],
        referenceType: "purchase_order",
        step: "purchase_order_mod",
        payload,
        operationKey: purchaseOperationKey(
          "purchase_order_mod",
          poIds[3],
          payload
        ),
      });
      assert(
        nested.status === "pending" && nested.dependsOn === null,
        "nested caller transaction did not create the chain root"
      );
    } finally {
      await outer.rollback();
    }

    console.log(
      "PASS: increase/reduction ordering, idempotency, failed→fixed wake, concurrent serialization, and nested caller transaction"
    );
  } finally {
    await db.raw(
      `DELETE FROM qb_purchase_dependency_chain
        WHERE purchase_order_id = ANY(?)`,
      [poIds]
    );
    await db.raw(
      `DELETE FROM qb_order_pipeline
        WHERE payload->>'verify_run_id' = ?`,
      [runId]
    );
    await db.destroy();
  }
}

void main();
