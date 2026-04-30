import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import { ensureCustomerInQb } from "../order-flow-core";
import { syncCustomerDataExtToQb } from "../sync-customer-data-ext";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

export async function processCustomerPipelineRow(
  row: { id: string; customer_id: string },
  customerModule: any,
  logger: any
): Promise<void> {
  const pool = getDbPool();

  try {
    const customer = await customerModule.retrieveCustomer(row.customer_id, {
      relations: ["addresses"],
    });

    const customerForQb = {
      id: customer.id,
      email: customer.email,
      first_name: customer.first_name ?? null,
      last_name: customer.last_name ?? null,
      company_name: (customer as any).company_name ?? null,
      phone: customer.phone ?? null,
      metadata: customer.metadata ?? {},
      addresses: (customer.addresses ?? []).map((a: any) => ({
        address_1: a.address_1,
        address_2: a.address_2,
        city: a.city,
        province: a.province,
        postal_code: a.postal_code,
        is_default_billing:
          a.is_default_billing ?? a.metadata?.is_default_billing ?? false,
        is_default_shipping:
          a.is_default_shipping ?? a.metadata?.is_default_shipping ?? false,
        metadata: a.metadata ?? {},
      })),
    };

    // Mark row 'submitted' so UI shows progress while the bridge call is in flight.
    await pool.query(
      `UPDATE qb_order_pipeline
          SET status = 'submitted', submitted_at = NOW(), updated_at = NOW(), error = NULL
        WHERE id = $1`,
      [row.id]
    );

    const result = await ensureCustomerInQb(
      customerForQb as any,
      customerModule,
      (msg) => logger.info(msg)
    );

    if (result.success && result.qbCustomerId) {
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status       = 'confirmed',
                qb_txn_id    = $2,
                confirmed_at = NOW(),
                updated_at   = NOW(),
                error        = NULL
          WHERE id = $1`,
        [row.id, result.qbCustomerId]
      );
      logger.info(
        `${LOG_PREFIX} ✅ Customer pipeline row ${row.id} confirmed — qb_list_id=${result.qbCustomerId}`
      );
    } else {
      const errMsg =
        result.error ?? "ensureCustomerInQb returned no qbCustomerId";
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status     = 'failed',
                failed_at  = NOW(),
                updated_at = NOW(),
                error      = $2
          WHERE id = $1`,
        [row.id, errMsg]
      );
      logger.warn(
        `${LOG_PREFIX} ❌ Customer pipeline row ${row.id} failed: ${errMsg}`
      );
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    await pool
      .query(
        `UPDATE qb_order_pipeline
            SET status     = 'failed',
                failed_at  = NOW(),
                updated_at = NOW(),
                error      = $2
          WHERE id = $1`,
        [row.id, msg]
      )
      .catch(() => {});
    logger.warn(
      `${LOG_PREFIX} ❌ Customer pipeline row ${row.id} exception: ${msg}`
    );
  }
}

export async function processCustomerDataExtPipelineRow(
  row: { id: string; customer_id: string },
  customerModule: any,
  logger: any
): Promise<void> {
  const pool = getDbPool();

  try {
    const customer = await customerModule.retrieveCustomer(row.customer_id);
    const meta = (customer.metadata ?? {}) as Record<string, unknown>;
    const qbListId =
      typeof meta.qb_list_id === "string" ? meta.qb_list_id : null;
    const channel =
      typeof meta.acquisition_channel === "string"
        ? (meta.acquisition_channel as string).trim()
        : "";

    if (!qbListId) {
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status='failed', failed_at=NOW(), updated_at=NOW(),
                error='customer has no qb_list_id in metadata'
          WHERE id=$1`,
        [row.id]
      );
      return;
    }
    if (!channel) {
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status='confirmed', confirmed_at=NOW(), updated_at=NOW(),
                error=NULL
          WHERE id=$1`,
        [row.id]
      );
      return;
    }

    await pool.query(
      `UPDATE qb_order_pipeline
          SET status='submitted', submitted_at=NOW(), updated_at=NOW(), error=NULL
        WHERE id=$1`,
      [row.id]
    );

    const result = await syncCustomerDataExtToQb({
      qbListId,
      dataExtName: "Distribution Channel",
      dataExtValue: channel,
      logger: {
        info: (m) => logger.info(`${LOG_PREFIX} ${m}`),
        warn: (m) => logger.warn(`${LOG_PREFIX} ${m}`),
      },
    });

    if (result.success) {
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status='confirmed', confirmed_at=NOW(), updated_at=NOW(),
                error=NULL
          WHERE id=$1`,
        [row.id]
      );
      logger.info(
        `${LOG_PREFIX} ✅ customer_data_ext row ${row.id} confirmed (${result.action}): ${qbListId} = "${channel}"`
      );
    } else {
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status='failed', failed_at=NOW(), updated_at=NOW(), error=$2
          WHERE id=$1`,
        [row.id, result.error ?? "unknown data-ext error"]
      );
      logger.warn(
        `${LOG_PREFIX} ❌ customer_data_ext row ${row.id} failed: ${result.error}`
      );
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    await pool
      .query(
        `UPDATE qb_order_pipeline
            SET status='failed', failed_at=NOW(), updated_at=NOW(), error=$2
          WHERE id=$1`,
        [row.id, msg]
      )
      .catch(() => {});
    logger.warn(
      `${LOG_PREFIX} ❌ customer_data_ext row ${row.id} exception: ${msg}`
    );
  }
}

export async function runCustomerPass(
  container: MedusaContainer,
  logger: any
): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: pendingCustomers } = await pool.query(`
      SELECT id, reference_id
        FROM qb_order_pipeline
       WHERE step = 'customer'
         AND status = 'pending'
         AND reference_id IS NOT NULL
       ORDER BY COALESCE(updated_at, created_at) ASC
       LIMIT 10
    `);

    if (pendingCustomers.length > 0) {
      const customerModule = container.resolve(Modules.CUSTOMER);
      logger.info(
        `${LOG_PREFIX} Processing ${pendingCustomers.length} pending customer row(s)...`
      );
      for (const custRow of pendingCustomers) {
        await processCustomerPipelineRow(
          { id: custRow.id, customer_id: custRow.reference_id },
          customerModule,
          logger
        );
      }
    }
  } catch (custPassErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Customer pipeline pass error: ${custPassErr.message}`
    );
  }
}

export async function runCustomerDataExtPass(
  container: MedusaContainer,
  logger: any
): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: pendingDataExt } = await pool.query(`
      SELECT id, reference_id
        FROM qb_order_pipeline
       WHERE step = 'customer_data_ext'
         AND status = 'pending'
         AND reference_id IS NOT NULL
       ORDER BY COALESCE(updated_at, created_at) ASC
       LIMIT 10
    `);

    if (pendingDataExt.length > 0) {
      const customerModule = container.resolve(Modules.CUSTOMER);
      logger.info(
        `${LOG_PREFIX} Processing ${pendingDataExt.length} pending customer_data_ext row(s)...`
      );
      for (const r of pendingDataExt) {
        await processCustomerDataExtPipelineRow(
          { id: r.id, customer_id: r.reference_id },
          customerModule,
          logger
        );
      }
    }
  } catch (dePassErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ customer_data_ext pass error: ${dePassErr.message}`
    );
  }
}
