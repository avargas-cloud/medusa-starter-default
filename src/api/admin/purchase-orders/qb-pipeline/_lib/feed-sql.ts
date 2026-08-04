/**
 * The Purchase Pipeline feed query, shared by the route that serves it and by
 * the verifier that audits it.
 *
 * It lives here so the verifier exercises THIS query rather than a copy: a
 * hand-maintained duplicate drifts, and a verifier comparing a copy against the
 * tables proves nothing about what the operator actually sees.
 *
 * Under `_lib/` on purpose — Medusa's API route loader skips that directory, so
 * this module never becomes an endpoint.
 *
 * WHY EVERY MOD IS ITS OWN ROW
 * ----------------------------
 * The legacy tables hold ONE row per document, so a mod REWRITES the row the
 * original ADD created (`purchase-orders/[id]/route.ts` UPDATEs the payload in
 * place; the consolidator mirrors status back through
 * `mirrorSubmittedToLegacy`). Two consequences, both fatal for an audit: the
 * previous mod is overwritten and gone, and the row keeps the ADD's
 * `created_at`, so a mod on an old PO never moves in a feed sorted by
 * `created_at DESC` — it stays buried on page 3 and looks like it never ran.
 *
 * Since the PO dependency chain landed (2026-07-27) every purchase operation
 * already INSERTS its own immutable `qb_order_pipeline` row
 * (`enqueuePurchaseQbOperation`). Those rows ARE the audit trail; the legacy
 * row is only a mirror. So each mod lane reads the append-only table, and the
 * legacy lanes suppress whatever a chain row already represents:
 *
 *   - a legacy PO row carrying `order_pipeline_id` renders as the ADD it really
 *     is (`purchase_order`), with the mirrored mod status/error stripped — that
 *     state now lives on the mod row that owns it;
 *   - a legacy ItemReceipt mod row is emitted only when `mod_order_pipeline_id`
 *     IS NULL, i.e. it predates the chain.
 *
 * Mods older than the chain keep rendering from the legacy row: they never got
 * a row of their own, and inventing one would fabricate accounting history.
 *
 * Careful when editing: this is a JS template literal, so a backtick inside a
 * SQL comment closes the string and breaks the parse.
 */

export const PURCHASE_PIPELINE_FEED_SQL = `
      SELECT numbered.*, numbered.seq::text AS seq_label FROM (
      SELECT
        feed.id,
        -- One running number per RECORD, oldest = 1. Before this, the column
        -- showed the DOCUMENT's number, so a PO with sixteen mods printed
        -- sixteen rows all labelled #125 and the table read as duplicated.
        --
        -- Computed here, over the WHOLE feed, and deliberately not in the outer
        -- query: numbering after the WHERE would renumber every row whenever
        -- the operator typed in the search box or switched the status filter.
        -- Ordered ASCENDING so a new operation always takes a higher number
        -- than everything already recorded, instead of pushing the rows below
        -- it down by one. It is still a POSITION, not an identity: deleting a
        -- row, or inserting one with an older created_at, shifts what comes
        -- after it.
        --
        -- ONE window function, with seq_label derived from it in the wrapper
        -- above: two independent ROW_NUMBER() calls that must agree can drift
        -- apart silently, and the label and the sort key disagreeing is exactly
        -- the kind of bug nobody reports because the number still "looks fine".
        ROW_NUMBER() OVER (ORDER BY feed.created_at ASC, feed.id ASC) AS seq,
        feed.parent_id,
        feed.po_number,
        feed.draft_number,
        feed.receipt_number,
        feed.vendor_bill_number,
        feed.status,
        feed.qb_operation_id,
        feed.qb_list_id,
        feed.qb_txn_number,
        feed.last_error,
        feed.retries,
        feed.coalesced_edits,
        feed.next_retry_at,
        feed.synced_at,
        feed.created_at,
        feed.updated_at,
        feed.vendor_name,
        feed.step
      FROM (

        -- ── Purchase Order pipeline (ADD / void) ─────────────────────────
        -- delegated = this row's live state belongs to a chained mod that has
        -- its own row below. Showing the mirrored status here too would both
        -- double-count it and pin a mod's error onto the ADD's creation date.
        -- (No backticks in these comments: this whole block is a JS template
        -- literal and a backtick would close it.)
        SELECT
          lane.id                                        AS id,
          lane.seq                                       AS seq,
          lane.seq::text                                 AS seq_label,
          lane.purchase_order_id                         AS parent_id,
          lane.po_number                                 AS po_number,
          lane.draft_number                              AS draft_number,
          NULL::text                                     AS receipt_number,
          NULL::text                                     AS vendor_bill_number,
          CASE WHEN lane.delegated THEN 'synced'
               ELSE lane.status END                      AS status,
          CASE WHEN lane.delegated THEN NULL
               ELSE lane.qb_operation_id END             AS qb_operation_id,
          lane.qb_list_id                                AS qb_list_id,
          lane.qb_txn_number                             AS qb_txn_number,
          CASE WHEN lane.delegated THEN NULL
               ELSE lane.last_error END                  AS last_error,
          CASE WHEN lane.delegated THEN 0
               ELSE lane.retries END                     AS retries,
          0                                              AS coalesced_edits,
          CASE WHEN lane.delegated THEN NULL
               ELSE lane.next_retry_at END               AS next_retry_at,
          lane.synced_at                                 AS synced_at,
          lane.created_at                                AS created_at,
          lane.updated_at                                AS updated_at,
          lane.vendor_name                               AS vendor_name,
          CASE
            WHEN lane.is_void_row THEN 'void_purchase_order'
            WHEN lane.delegated   THEN 'purchase_order'
            WHEN lane.is_mod_row  THEN 'mod_purchase_order'
            ELSE 'purchase_order'
          END                                            AS step
        FROM (
          SELECT
            pipe.id, pipe.seq, pipe.purchase_order_id, pipe.status,
            pipe.qb_operation_id, pipe.qb_list_id, pipe.qb_txn_number,
            pipe.last_error, pipe.retries, pipe.next_retry_at, pipe.synced_at,
            pipe.created_at, pipe.updated_at,
            po.number                                     AS po_number,
            po.draft_number                               AS draft_number,
            COALESCE(po.vendor_name_snapshot, po.vendor_id) AS vendor_name,
            ((pipe.payload->>'is_void')::boolean IS TRUE)  AS is_void_row,
            ((pipe.payload->>'is_mod')::boolean IS TRUE)   AS is_mod_row,
            -- A void re-arms this same row and has no chain row of its own, so
            -- it always keeps rendering from here. qb_list_id must be present:
            -- if the ADD never reached QuickBooks, its real state stays visible.
            ((pipe.payload->>'is_void')::boolean IS NOT TRUE
              AND pipe.order_pipeline_id IS NOT NULL
              AND pipe.qb_list_id IS NOT NULL)             AS delegated
          FROM qb_purchase_order_pipeline pipe
          LEFT JOIN purchase_order po ON po.id = pipe.purchase_order_id
          WHERE pipe.deleted_at IS NULL
        ) lane

        UNION ALL

        -- ── Purchase Order MOD history (append-only, one row per mod) ────
        SELECT
          qop.id::text || '__purchase_order_mod'         AS id,
          NULL::bigint                                   AS seq,
          -- Same label as the PO's own row so both read as one document.
          -- Scalar subquery, not a join: a duplicate legacy row would otherwise
          -- multiply this mod into two audit rows.
          (SELECT l.seq::text
             FROM qb_purchase_order_pipeline l
            WHERE l.purchase_order_id = qop.order_id
              AND l.deleted_at IS NULL
            ORDER BY l.seq
            LIMIT 1)                                     AS seq_label,
          qop.order_id                                   AS parent_id,
          po.number                                      AS po_number,
          po.draft_number                                AS draft_number,
          NULL::text                                     AS receipt_number,
          NULL::text                                     AS vendor_bill_number,
          CASE
            WHEN qop.status IN ('confirmed','fixed') THEN 'synced'
            WHEN qop.status = 'skipped' THEN 'skipped'
            WHEN qop.status = 'failed' AND qop.next_retry_at IS NULL THEN 'failed_permanent'
            WHEN qop.status = 'failed' THEN 'error'
            WHEN qop.status IN ('submitted','processing') THEN 'submitted'
            ELSE 'waiting'
          END                                            AS status,
          qop.bridge_op_id                               AS qb_operation_id,
          COALESCE(qop.qb_txn_id, po.qb_purchase_order_list_id)
                                                           AS qb_list_id,
          po.qb_purchase_order_txn_number                AS qb_txn_number,
          qop.error                                      AS last_error,
          COALESCE(qop.retry_count, 0)                   AS retries,
          -- How many later edits this queued operation absorbed before it was
          -- sent. Surfaced so collapsing reads as one operation carrying N
          -- edits, never as edits that quietly disappeared.
          COALESCE((qop.payload->>'coalesced_edits')::int, 0)
                                                           AS coalesced_edits,
          qop.next_retry_at                              AS next_retry_at,
          qop.confirmed_at                               AS synced_at,
          qop.created_at                                 AS created_at,
          COALESCE(qop.updated_at, qop.confirmed_at, qop.failed_at,
                   qop.submitted_at, qop.created_at)     AS updated_at,
          COALESCE(po.vendor_name_snapshot, po.vendor_id) AS vendor_name,
          'mod_purchase_order'                           AS step
        FROM qb_order_pipeline qop
        LEFT JOIN purchase_order po ON po.id = qop.order_id
        WHERE qop.step = 'purchase_order_mod'

        UNION ALL

        -- ── ItemReceipt ADD pipeline (always emit one row) ───────────────
        SELECT
          qbp.id                                         AS id,
          qbp.seq                                        AS seq,
          ('R' || qbp.seq::text)                         AS seq_label,
          qbp.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          NULL::text                                     AS draft_number,
          por.number                                     AS receipt_number,
          NULL::text                                     AS vendor_bill_number,
          qbp.status                                     AS status,
          qbp.qb_operation_id                            AS qb_operation_id,
          qbp.qb_list_id                                 AS qb_list_id,
          NULL::text                                     AS qb_txn_number,
          qbp.last_error                                 AS last_error,
          qbp.retries                                    AS retries,
          0                                              AS coalesced_edits,
          qbp.next_retry_at                              AS next_retry_at,
          qbp.synced_at                                  AS synced_at,
          qbp.created_at                                 AS created_at,
          qbp.updated_at                                 AS updated_at,
          COALESCE(po.vendor_name_snapshot, po.vendor_id) AS vendor_name,
          'add_item_receipt'                             AS step
        FROM qb_item_receipt_pipeline qbp
        LEFT JOIN purchase_order_receipt por ON por.id = qbp.purchase_order_receipt_id
        LEFT JOIN purchase_order po ON po.id = qbp.purchase_order_id
        WHERE qbp.deleted_at IS NULL

        UNION ALL

        -- ── ItemReceipt MOD history (append-only, one row per mod) ──────
        SELECT
          qop.id::text || '__item_receipt_mod'           AS id,
          NULL::bigint                                   AS seq,
          (SELECT 'R' || l.seq::text
             FROM qb_item_receipt_pipeline l
            WHERE l.purchase_order_receipt_id = qop.reference_id
              AND l.deleted_at IS NULL
            ORDER BY l.seq
            LIMIT 1)                                     AS seq_label,
          qop.order_id                                   AS parent_id,
          po.number                                      AS po_number,
          NULL::text                                     AS draft_number,
          por.number                                     AS receipt_number,
          NULL::text                                     AS vendor_bill_number,
          CASE
            WHEN qop.status IN ('confirmed','fixed') THEN 'synced'
            WHEN qop.status = 'skipped' THEN 'skipped'
            WHEN qop.status = 'failed' AND qop.next_retry_at IS NULL THEN 'failed_permanent'
            WHEN qop.status = 'failed' THEN 'error'
            WHEN qop.status IN ('submitted','processing') THEN 'submitted'
            ELSE 'waiting'
          END                                            AS status,
          qop.bridge_op_id                               AS qb_operation_id,
          qop.qb_txn_id                                  AS qb_list_id,
          NULL::text                                     AS qb_txn_number,
          qop.error                                      AS last_error,
          COALESCE(qop.retry_count, 0)                   AS retries,
          COALESCE((qop.payload->>'coalesced_edits')::int, 0)
                                                           AS coalesced_edits,
          qop.next_retry_at                              AS next_retry_at,
          qop.confirmed_at                               AS synced_at,
          qop.created_at                                 AS created_at,
          COALESCE(qop.updated_at, qop.confirmed_at, qop.failed_at,
                   qop.submitted_at, qop.created_at)     AS updated_at,
          COALESCE(po.vendor_name_snapshot, po.vendor_id) AS vendor_name,
          'mod_item_receipt'                             AS step
        FROM qb_order_pipeline qop
        LEFT JOIN purchase_order_receipt por ON por.id = qop.reference_id
        LEFT JOIN purchase_order po ON po.id = qop.order_id
        WHERE qop.step = 'item_receipt_mod'

        UNION ALL

        -- ── ItemReceipt MOD, pre-chain history only ─────────────────────
        -- One mod slot per receipt: a second mod overwrote the first. Rows
        -- carrying mod_order_pipeline_id are represented by the lane above.
        SELECT
          qbp.id || '__mod'                              AS id,
          qbp.seq                                        AS seq,
          ('R' || qbp.seq::text)                         AS seq_label,
          qbp.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          NULL::text                                     AS draft_number,
          por.number                                     AS receipt_number,
          NULL::text                                     AS vendor_bill_number,
          qbp.mod_status                                 AS status,
          qbp.mod_operation_id                           AS qb_operation_id,
          qbp.qb_list_id                                 AS qb_list_id,
          NULL::text                                     AS qb_txn_number,
          qbp.mod_last_error                             AS last_error,
          COALESCE(qbp.mod_retries, 0)                   AS retries,
          0                                              AS coalesced_edits,
          qbp.mod_next_retry_at                          AS next_retry_at,
          qbp.mod_synced_at                               AS synced_at,
          qbp.created_at                                 AS created_at,
          qbp.updated_at                                 AS updated_at,
          COALESCE(po.vendor_name_snapshot, po.vendor_id) AS vendor_name,
          'mod_item_receipt'                             AS step
        FROM qb_item_receipt_pipeline qbp
        LEFT JOIN purchase_order_receipt por ON por.id = qbp.purchase_order_receipt_id
        LEFT JOIN purchase_order po ON po.id = qbp.purchase_order_id
        WHERE qbp.deleted_at IS NULL
          AND qbp.mod_status IS NOT NULL
          AND qbp.mod_order_pipeline_id IS NULL

        UNION ALL

        -- ── ItemReceipt VOID/DELETE pipeline (only when void_status is set)
        SELECT
          qbp.id || '__void'                             AS id,
          qbp.seq                                        AS seq,
          ('R' || qbp.seq::text)                         AS seq_label,
          qbp.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          NULL::text                                     AS draft_number,
          por.number                                     AS receipt_number,
          NULL::text                                     AS vendor_bill_number,
          qbp.void_status                                AS status,
          qbp.void_operation_id                          AS qb_operation_id,
          qbp.qb_list_id                                 AS qb_list_id,
          NULL::text                                     AS qb_txn_number,
          qbp.void_last_error                            AS last_error,
          COALESCE(qbp.void_retries, 0)                  AS retries,
          0                                              AS coalesced_edits,
          qbp.void_next_retry_at                         AS next_retry_at,
          qbp.void_synced_at                             AS synced_at,
          qbp.created_at                                 AS created_at,
          qbp.updated_at                                 AS updated_at,
          COALESCE(po.vendor_name_snapshot, po.vendor_id) AS vendor_name,
          'delete_item_receipt'                          AS step
        FROM qb_item_receipt_pipeline qbp
        LEFT JOIN purchase_order_receipt por ON por.id = qbp.purchase_order_receipt_id
        LEFT JOIN purchase_order po ON po.id = qbp.purchase_order_id
        WHERE qbp.deleted_at IS NULL
          AND qbp.void_status IS NOT NULL

        UNION ALL

        -- ── Vendor Bill ADD pipeline ─────────────────────────────────────
        -- MOD reuses the operational qvb row. Once a QB TxnID exists, keep
        -- representing the original ADD as terminal history while MOD history
        -- comes from its append-only qb_order_pipeline rows below.
        SELECT
          qvb.id || '__vendor_bill_add'                  AS id,
          NULL::bigint                                   AS seq,
          ('B' || COALESCE(regexp_replace(vb.number, '\\D', '', 'g'), '?'))
                                                           AS seq_label,
          qvb.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          po.draft_number                                AS draft_number,
          NULL::text                                     AS receipt_number,
          vb.number                                      AS vendor_bill_number,
          CASE
            WHEN qvb.qb_txn_id IS NOT NULL THEN 'synced'
            WHEN qvb.intent = 'add' THEN qvb.status
            ELSE qvb.status
          END                                            AS status,
          CASE
            WHEN qvb.qb_txn_id IS NULL AND qvb.intent = 'add'
              THEN qvb.qb_operation_id
          END
                                                           AS qb_operation_id,
          qvb.qb_txn_id                                  AS qb_list_id,
          COALESCE(qvb.qb_ref_number, vb.reference_id)   AS qb_txn_number,
          CASE
            WHEN qvb.qb_txn_id IS NULL AND qvb.intent = 'add'
              THEN qvb.last_error
          END
                                                           AS last_error,
          CASE
            WHEN qvb.qb_txn_id IS NULL AND qvb.intent = 'add'
              THEN qvb.retries
            ELSE 0
          END
                                                           AS retries,
          0                                              AS coalesced_edits,
          CASE
            WHEN qvb.qb_txn_id IS NULL AND qvb.intent = 'add'
              THEN qvb.next_retry_at
          END
                                                           AS next_retry_at,
          COALESCE(qvb.synced_at, vb.qb_synced_at)       AS synced_at,
          COALESCE(vb.confirmed_at, qvb.created_at)      AS created_at,
          qvb.updated_at                                 AS updated_at,
          COALESCE(vb.vendor_name_snapshot, po.vendor_name_snapshot, po.vendor_id)
                                                           AS vendor_name,
          'add_vendor_bill'                              AS step
        FROM qb_vendor_bill_pipeline qvb
        JOIN vendor_bill vb ON vb.id = qvb.vendor_bill_id AND vb.deleted_at IS NULL
        LEFT JOIN purchase_order po ON po.id = qvb.purchase_order_id
        WHERE qvb.deleted_at IS NULL
          AND (qvb.intent = 'add' OR qvb.qb_txn_id IS NOT NULL)

        UNION ALL

        -- ── Vendor Bill MOD history ──────────────────────────────────────
        SELECT
          qop.id::text || '__vendor_bill_mod'            AS id,
          NULL::bigint                                   AS seq,
          ('B' || COALESCE(regexp_replace(vb.number, '\\D', '', 'g'), '?'))
                                                           AS seq_label,
          qop.order_id                                   AS parent_id,
          po.number                                      AS po_number,
          po.draft_number                                AS draft_number,
          NULL::text                                     AS receipt_number,
          vb.number                                      AS vendor_bill_number,
          CASE
            WHEN qop.status IN ('confirmed','fixed') THEN 'synced'
            WHEN qop.status = 'skipped' THEN 'skipped'
            WHEN qop.status = 'failed' AND qop.next_retry_at IS NULL THEN 'failed_permanent'
            WHEN qop.status = 'failed' THEN 'error'
            WHEN qop.status IN ('submitted','processing') THEN 'submitted'
            ELSE 'waiting'
          END                                            AS status,
          qop.bridge_op_id                               AS qb_operation_id,
          COALESCE(qop.qb_txn_id, vb.qb_txn_id)          AS qb_list_id,
          COALESCE(qop.qb_ref_number, vb.reference_id)   AS qb_txn_number,
          qop.error                                      AS last_error,
          COALESCE(qop.retry_count, 0)                   AS retries,
          0                                              AS coalesced_edits,
          qop.next_retry_at                              AS next_retry_at,
          qop.confirmed_at                               AS synced_at,
          qop.created_at                                 AS created_at,
          COALESCE(qop.updated_at, qop.confirmed_at, qop.failed_at, qop.submitted_at, qop.created_at)
                                                           AS updated_at,
          COALESCE(vb.vendor_name_snapshot, po.vendor_name_snapshot, po.vendor_id)
                                                           AS vendor_name,
          'mod_vendor_bill'                              AS step
        FROM qb_order_pipeline qop
        JOIN vendor_bill vb ON vb.id = qop.reference_id AND vb.deleted_at IS NULL
        LEFT JOIN purchase_order po ON po.id = qop.order_id
        WHERE qop.step = 'vendor_bill_mod'

        UNION ALL

        -- ── Vendor Bill reviewed REBUILD history ─────────────────────────
        SELECT
          qop.id::text || CASE
            WHEN qop.step = 'vendor_bill_rebuild_preflight'
              THEN '__vendor_bill_rebuild_preflight'
            ELSE '__vendor_bill_rebuild_delete'
          END                                              AS id,
          NULL::bigint                                     AS seq,
          ('B' || COALESCE(regexp_replace(vb.number, '\\D', '', 'g'), '?'))
                                                             AS seq_label,
          qop.order_id                                     AS parent_id,
          po.number                                        AS po_number,
          po.draft_number                                  AS draft_number,
          NULL::text                                       AS receipt_number,
          vb.number                                        AS vendor_bill_number,
          CASE
            WHEN qop.status IN ('confirmed','fixed') THEN 'synced'
            WHEN qop.status = 'skipped' THEN 'skipped'
            WHEN qop.status = 'failed' AND qop.next_retry_at IS NULL
              THEN 'failed_permanent'
            WHEN qop.status = 'failed' THEN 'error'
            WHEN qop.status IN ('submitted','processing') THEN 'submitted'
            ELSE 'waiting'
          END                                              AS status,
          qop.bridge_op_id                                 AS qb_operation_id,
          qop.qb_txn_id                                    AS qb_list_id,
          COALESCE(qop.qb_ref_number, vb.reference_id)     AS qb_txn_number,
          qop.error                                        AS last_error,
          COALESCE(qop.retry_count, 0)                     AS retries,
          0                                              AS coalesced_edits,
          qop.next_retry_at                                AS next_retry_at,
          qop.confirmed_at                                 AS synced_at,
          qop.created_at                                   AS created_at,
          COALESCE(
            qop.updated_at, qop.confirmed_at, qop.failed_at,
            qop.submitted_at, qop.created_at
          )                                                AS updated_at,
          COALESCE(
            vb.vendor_name_snapshot, po.vendor_name_snapshot, po.vendor_id
          )                                                AS vendor_name,
          CASE
            WHEN qop.step = 'vendor_bill_rebuild_preflight'
              THEN 'preflight_vendor_bill_rebuild'
            ELSE 'delete_vendor_bill_rebuild'
          END                                              AS step
        FROM qb_order_pipeline qop
        JOIN vendor_bill vb
          ON vb.id = qop.reference_id AND vb.deleted_at IS NULL
        LEFT JOIN purchase_order po ON po.id = qop.order_id
        WHERE qop.step IN (
          'vendor_bill_rebuild_preflight',
          'vendor_bill_rebuild_delete'
        )

        UNION ALL

        -- ── Vendor Bill DELETE pipeline ──────────────────────────────────
        SELECT
          qvb.id || '__vendor_bill_delete'               AS id,
          NULL::bigint                                   AS seq,
          ('B' || COALESCE(regexp_replace(vb.number, '\\D', '', 'g'), '?'))
                                                           AS seq_label,
          qvb.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          po.draft_number                                AS draft_number,
          NULL::text                                     AS receipt_number,
          vb.number                                      AS vendor_bill_number,
          CASE WHEN qvb.void_status = 'completed' THEN 'synced'
               ELSE qvb.void_status END                  AS status,
          qvb.void_operation_id                          AS qb_operation_id,
          qvb.qb_txn_id                                  AS qb_list_id,
          COALESCE(qvb.qb_ref_number, vb.reference_id)   AS qb_txn_number,
          qvb.void_last_error                            AS last_error,
          COALESCE(qvb.void_retries, 0)                  AS retries,
          0                                              AS coalesced_edits,
          qvb.void_next_retry_at                         AS next_retry_at,
          CASE WHEN qvb.void_status IN ('synced','completed') THEN qvb.updated_at END
                                                           AS synced_at,
          qvb.created_at                                 AS created_at,
          qvb.updated_at                                 AS updated_at,
          COALESCE(vb.vendor_name_snapshot, po.vendor_name_snapshot, po.vendor_id)
                                                           AS vendor_name,
          'delete_vendor_bill'                           AS step
        FROM qb_vendor_bill_pipeline qvb
        JOIN vendor_bill vb ON vb.id = qvb.vendor_bill_id AND vb.deleted_at IS NULL
        LEFT JOIN purchase_order po ON po.id = qvb.purchase_order_id
        WHERE qvb.deleted_at IS NULL
          AND qvb.void_status IS NOT NULL
      ) feed
      ) numbered
    `;
