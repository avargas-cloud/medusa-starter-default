import type { ExecArgs } from "@medusajs/framework/types";

import {
  enqueueChinaAgencyVendorBillModGroup,
  type VendorBillModKnex,
} from "../../lib/purchase-orders/qb-vendor-bill-mod-enqueue";

type Transaction = VendorBillModKnex & {
  rollback: () => Promise<void>;
};

type Knex = VendorBillModKnex & {
  transaction: () => Promise<Transaction>;
};

export default async function verifyChinaAgencyVendorBillMod({
  container,
}: ExecArgs): Promise<void> {
  const knex = container.resolve("__pg_connection__") as unknown as Knex;
  const target = await knex.raw(
    `SELECT vb.id, vb.number
       FROM vendor_bill vb
      WHERE vb.deleted_at IS NULL
        AND vb.bill_type = 'regular'
        AND vb.status = 'synced'
        AND vb.qb_source IS NULL
        AND vb.qb_txn_id IS NOT NULL
        AND vb.service_vendor_bill_id IS NOT NULL
        AND vb.freight_vendor_bill_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM qb_vendor_bill_pipeline p
           WHERE p.vendor_bill_id IN (
             vb.id, vb.service_vendor_bill_id, vb.freight_vendor_bill_id
           )
             AND p.deleted_at IS NULL
             AND p.status IN ('waiting','submitted','error')
        )
      ORDER BY vb.number
      LIMIT 1`
  );
  const bill = target.rows[0] as { id: string; number: string } | undefined;
  if (!bill) throw new Error("No safe synced China Agency test group found");

  const trx = await knex.transaction();
  try {
    const result = await enqueueChinaAgencyVendorBillModGroup(trx, bill.id);
    if (!result.queued) throw new Error(result.reason);

    const rows = await trx.raw(
      `SELECT p.vendor_bill_id, p.intent, p.status, p.payload, vb.bill_type
         FROM qb_vendor_bill_pipeline p
         JOIN vendor_bill vb ON vb.id = p.vendor_bill_id
        WHERE p.vendor_bill_id = ANY(?)
          AND p.deleted_at IS NULL
        ORDER BY p.vendor_bill_id`,
      [result.billIds]
    );
    if (rows.rows.length !== result.billIds.length) {
      throw new Error(
        `Expected ${result.billIds.length} queued rows, found ${rows.rows.length}`
      );
    }
    const centralRows = await trx.raw(
      `SELECT id, reference_id, step, status, depends_on, payload
         FROM qb_order_pipeline
        WHERE reference_id = ANY(?)
          AND step = 'vendor_bill_mod'
        ORDER BY created_at, id`,
      [result.billIds]
    );
    if (centralRows.rows.length !== result.billIds.length) {
      throw new Error(
        `Expected ${result.billIds.length} central rows, found ${centralRows.rows.length}`
      );
    }
    let previousCentralId: string | null = null;
    for (let index = 0; index < centralRows.rows.length; index++) {
      const raw = centralRows.rows[index];
      const row = raw as {
        id: string;
        step: string;
        status: string;
        depends_on: string | null;
        payload: { qb_vendor_bill_pipeline_id?: string };
      };
      const expectedStatusOk =
        index === 0
          ? row.status === "pending" || row.status === "waiting"
          : row.status === "waiting";
      const expectedDependencyOk =
        index === 0 || row.depends_on === previousCentralId;
      if (
        row.step !== "vendor_bill_mod" ||
        !expectedStatusOk ||
        !expectedDependencyOk ||
        !row.payload.qb_vendor_bill_pipeline_id
      ) {
        throw new Error(
          "Central BillMod rows are not one serialized dependency chain"
        );
      }
      previousCentralId = row.id;
    }
    for (const raw of rows.rows) {
      const row = raw as {
        intent: string;
        status: string;
        bill_type: string;
        payload: {
          txn_id?: string;
          edit_sequence?: string;
          item_lines?: Array<{ qb_txn_line_id?: string }>;
          expense_lines?: Array<{ qb_txn_line_id?: string }>;
          __mod_group_id?: string;
        };
      };
      if (row.intent !== "mod" || row.status !== "waiting") {
        throw new Error(`Unexpected pipeline state ${row.intent}/${row.status}`);
      }
      if (
        !row.payload.txn_id ||
        !row.payload.edit_sequence ||
        row.payload.__mod_group_id !== result.groupId
      ) {
        throw new Error("BillMod payload is missing group/header identity");
      }
      const lines = [
        ...(row.payload.item_lines ?? []),
        ...(row.payload.expense_lines ?? []),
      ];
      if (lines.length === 0 || lines.some((line) => !line.qb_txn_line_id)) {
        throw new Error("BillMod payload does not preserve every TxnLineID");
      }
    }
    const typedRows = rows.rows as Array<{
      bill_type: string;
      payload: {
        item_lines?: unknown[];
        expense_lines?: Array<{ amount_cents?: number }>;
      };
    }>;
    const regularPayload = typedRows.find(
      (row) => row.bill_type === "regular"
    )?.payload;
    const componentTotals = typedRows
      .filter((row) => row.bill_type !== "regular")
      .map((row) =>
        (row.payload.expense_lines ?? []).reduce(
          (sum, line) => sum + Number(line.amount_cents ?? 0),
          0
        )
      )
      .sort((a, b) => a - b);
    const clearingTotals = (regularPayload?.expense_lines ?? [])
      .map((line) => -Number(line.amount_cents ?? 0))
      .sort((a, b) => a - b);
    if (JSON.stringify(componentTotals) !== JSON.stringify(clearingTotals)) {
      throw new Error(
        `Regular clearing ${JSON.stringify(clearingTotals)} does not offset ` +
          `component bills ${JSON.stringify(componentTotals)}`
      );
    }
    console.log(
      `PASS ${bill.number}: atomically froze ${rows.rows.length} BillMod rows ` +
        `and ${centralRows.rows.length} central dispatch rows ` +
        `under group ${result.groupId}; all retained lines have TxnLineID and ` +
        `Regular clearing exactly offsets component bills`
    );
  } finally {
    await trx.rollback();
  }
}
