import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import { ensureCustomerInQb } from "../order-flow-core";
import { syncCustomerDataExtToQb } from "../sync-customer-data-ext";
import { decideRetry, type RetryDecision } from "../retry-config";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

/**
 * Apply a uniform retry decision to a qb_order_pipeline row after a failure.
 *
 * Replaces the old `status='failed'`-direct branches that gave 3170-class
 * lock errors no chance to retry (incident PO #34, 2026-05-01). Transient
 * errors now park at `status='error'` with a backoff timestamp; the consolidator
 * picks them up on the next tick once `next_retry_at <= NOW()`. Permanent
 * errors and exhausted retries still land at `status='failed'` (legacy
 * terminal — preserved for downstream UI/consumer compatibility).
 */
async function applyCustomerPipelineFailure(
  pool: ReturnType<typeof getDbPool>,
  rowId: string,
  retriesSoFar: number,
  errorMessage: string
): Promise<RetryDecision> {
  const decision = decideRetry({
    error: { message: errorMessage },
    retriesSoFar,
    hasNextRetryAt: true,
    hasFailedPermanent: false,
  });

  if (decision.newStatus === "error") {
    await pool
      .query(
        `UPDATE qb_order_pipeline
            SET status        = 'error',
                retry_count   = $2,
                error         = $3,
                next_retry_at = $4,
                updated_at    = NOW()
          WHERE id = $1`,
        [rowId, decision.newRetries, errorMessage, decision.nextRetryAt]
      )
      .catch(() => {});
  } else {
    await pool
      .query(
        `UPDATE qb_order_pipeline
            SET status        = 'failed',
                retry_count   = $2,
                error         = $3,
                failed_at     = NOW(),
                next_retry_at = NULL,
                updated_at    = NOW()
          WHERE id = $1`,
        [rowId, decision.newRetries, errorMessage]
      )
      .catch(() => {});
  }
  return decision;
}

export async function processCustomerPipelineRow(
  row: { id: string; customer_id: string; retry_count?: number },
  customerModule: any,
  logger: any
): Promise<void> {
  const pool = getDbPool();
  const retriesSoFar = row.retry_count ?? 0;

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
      const decision = await applyCustomerPipelineFailure(
        pool,
        row.id,
        retriesSoFar,
        errMsg
      );
      logger.warn(
        `${LOG_PREFIX} ❌ Customer pipeline row ${row.id} → ${decision.newStatus} (${decision.classification.class}, retry ${decision.newRetries}): ${errMsg}`
      );
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const decision = await applyCustomerPipelineFailure(
      pool,
      row.id,
      retriesSoFar,
      msg
    );
    logger.warn(
      `${LOG_PREFIX} ❌ Customer pipeline row ${row.id} exception → ${decision.newStatus} (${decision.classification.class}, retry ${decision.newRetries}): ${msg}`
    );
  }
}

export async function processCustomerDataExtPipelineRow(
  row: { id: string; customer_id: string; retry_count?: number },
  customerModule: any,
  logger: any
): Promise<void> {
  const pool = getDbPool();
  const retriesSoFar = row.retry_count ?? 0;

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
      // Permanent: customer master sync hasn't completed yet, can't add DataExt.
      // Classifier routes "permanent" → `failed` directly (no retry).
      await applyCustomerPipelineFailure(
        pool,
        row.id,
        retriesSoFar,
        "customer has no qb_list_id in metadata"
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
      const errMsg = result.error ?? "unknown data-ext error";
      const decision = await applyCustomerPipelineFailure(
        pool,
        row.id,
        retriesSoFar,
        errMsg
      );
      logger.warn(
        `${LOG_PREFIX} ❌ customer_data_ext row ${row.id} → ${decision.newStatus} (${decision.classification.class}, retry ${decision.newRetries}): ${errMsg}`
      );
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const decision = await applyCustomerPipelineFailure(
      pool,
      row.id,
      retriesSoFar,
      msg
    );
    logger.warn(
      `${LOG_PREFIX} ❌ customer_data_ext row ${row.id} exception → ${decision.newStatus} (${decision.classification.class}, retry ${decision.newRetries}): ${msg}`
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
      SELECT id, reference_id, COALESCE(retry_count, 0) AS retry_count
        FROM qb_order_pipeline
       WHERE step = 'customer'
         AND (
           status = 'pending'
           OR (status = 'error' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
         )
         AND reference_id IS NOT NULL
       ORDER BY COALESCE(updated_at, created_at) ASC
       LIMIT 10
    `);

    if (pendingCustomers.length > 0) {
      const customerModule = container.resolve(Modules.CUSTOMER);
      logger.info(
        `${LOG_PREFIX} Processing ${pendingCustomers.length} pending/retrying customer row(s)...`
      );
      for (const custRow of pendingCustomers) {
        await processCustomerPipelineRow(
          {
            id: custRow.id,
            customer_id: custRow.reference_id,
            retry_count: custRow.retry_count,
          },
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
      SELECT id, reference_id, COALESCE(retry_count, 0) AS retry_count
        FROM qb_order_pipeline
       WHERE step = 'customer_data_ext'
         AND (
           status = 'pending'
           OR (status = 'error' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
         )
         AND reference_id IS NOT NULL
       ORDER BY COALESCE(updated_at, created_at) ASC
       LIMIT 10
    `);

    if (pendingDataExt.length > 0) {
      const customerModule = container.resolve(Modules.CUSTOMER);
      logger.info(
        `${LOG_PREFIX} Processing ${pendingDataExt.length} pending/retrying customer_data_ext row(s)...`
      );
      for (const r of pendingDataExt) {
        await processCustomerDataExtPipelineRow(
          {
            id: r.id,
            customer_id: r.reference_id,
            retry_count: r.retry_count,
          },
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
