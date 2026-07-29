/**
 * The one authoritative recomputation of an order's money.
 *
 * Lives here, as a string, because TWO migrations install it: 1781600000000
 * created it and 1781700000000 replaced it after the mirror guard was found to
 * treat an ABSENT metadata key as zero. A migration that already ran cannot be
 * edited into production, so the fix needs its own — and the body must not exist
 * in two hand-kept copies, which is the failure this codebase keeps paying for.
 * A future correction edits this file and adds one more thin migration.
 *
 * No backticks anywhere in the SQL: a backtick inside a SQL comment embedded in
 * a JS template literal closes the string and breaks the parse.
 */
export const RECOMPUTE_ORDER_MONEY_SQL = `
      CREATE OR REPLACE FUNCTION recompute_order_money(p_order_id text)
      RETURNS void AS $$
      DECLARE
        v_applied     bigint;
        v_order_only  bigint;
        v_unapplied   bigint;
        v_total       bigint;
        v_deposit     bigint;
        v_mirror      numeric;
        v_applied_d   numeric;
      BEGIN
        IF p_order_id IS NULL THEN
          RETURN;
        END IF;

        -- Nothing to project for an order that does not exist (or is gone).
        IF NOT EXISTS (SELECT 1 FROM "order" WHERE id = p_order_id) THEN
          DELETE FROM order_money_projection WHERE order_id = p_order_id;
          RETURN;
        END IF;

        -- APPLIED means "consumed by an invoice", so it counts only
        -- applications that name one. An application with invoice_id NULL is an
        -- ORDER-ONLY reservation — money parked against the order and not billed
        -- against anything — which is precisely what a deposit is.
        --
        -- Summing both together was the modelling error that made this whole
        -- thing look broken: S11186 holds a $400 order-only reservation on an
        -- $898.92 order, and counting it as applied reported Deposit $0 / Paid
        -- $400 and classified the order as covered. Every order carrying a real
        -- deposit disappeared from the Deposited view that way, which is why the
        -- only rows left in it were fully_paid ones.
        SELECT COALESCE(SUM(amount_applied), 0)::bigint
          INTO v_applied
        FROM payment_application
        WHERE order_id = p_order_id
          AND invoice_id IS NOT NULL
          AND deleted_at IS NULL
          AND voided_at IS NULL;

        SELECT COALESCE(SUM(amount_applied), 0)::bigint
          INTO v_order_only
        FROM payment_application
        WHERE order_id = p_order_id
          AND invoice_id IS NULL
          AND deleted_at IS NULL
          AND voided_at IS NULL;

        SELECT COALESCE(SUM(GREATEST(0, cp.amount - COALESCE(ap.cents, 0))), 0)::bigint
          INTO v_unapplied
        FROM customer_payment cp
        LEFT JOIN (
          SELECT payment_id, SUM(amount_applied) AS cents
          FROM payment_application
          WHERE deleted_at IS NULL AND voided_at IS NULL
          GROUP BY payment_id
        ) ap ON ap.payment_id = cp.id
        WHERE COALESCE(cp.locked_order_id, cp.metadata->>'order_id') = p_order_id
          AND cp.deleted_at IS NULL
          AND cp.status NOT IN ('voided', 'refunded');

        -- pos_total outranks the summary, mirroring getOrderTotal() in
        -- build-order-doc.ts and orders/utils.ts.
        SELECT round(
                 CASE
                   WHEN COALESCE(NULLIF(o.metadata->>'pos_total', '')::numeric, 0) > 0
                     THEN COALESCE(NULLIF(o.metadata->>'pos_total', '')::numeric, 0)
                   ELSE COALESCE((
                     SELECT (os.totals->>'current_order_total')::numeric
                     FROM order_summary os
                     WHERE os.order_id = o.id
                       AND os.deleted_at IS NULL
                       AND os.version = o.version
                     LIMIT 1
                   ), 0)
                 END * 100
               )::bigint
          INTO v_total
        FROM "order" o
        WHERE o.id = p_order_id;

        v_total := COALESCE(v_total, 0);

        -- THE TOTAL IS THE CEILING: applied + deposit can never exceed it.
        -- Operator's rule, stated three times and enforced by CHECK below.
        --
        -- So the deposit is bounded by what the order still has room for. Money
        -- beyond that is a genuine overpayment and belongs to the CUSTOMER as
        -- unlinked credit, not to this order — the $5,000-on-a-$4,000-order case:
        -- $4,000 is this order's deposit and $1,000 stays free for a future one.
        --
        -- This is only coherent because applied counts invoice-consumed money
        -- ONLY. While order-only reservations were lumped into applied, this
        -- bound zeroed the deposit of every order carrying one — S11186's $400 on
        -- an $898.92 order — which is what made the ceiling and "show me my
        -- deposits" look like conflicting demands. They are not.
        IF v_total > 0 THEN
          v_deposit := LEAST(v_order_only + v_unapplied,
                             GREATEST(0, v_total - v_applied));
        ELSE
          v_deposit := v_order_only + v_unapplied;  -- fail-open: no readable total
        END IF;

        INSERT INTO order_money_projection AS omp (
          order_id, applied_cents, order_only_cents, unapplied_cents,
          order_total_cents, deposit_cents, calculator_version, computed_at
        ) VALUES (
          p_order_id, v_applied, v_order_only, v_unapplied,
          v_total, v_deposit, 1, now()
        )
        ON CONFLICT (order_id) DO UPDATE SET
          applied_cents     = EXCLUDED.applied_cents,
          order_only_cents  = EXCLUDED.order_only_cents,
          unapplied_cents   = EXCLUDED.unapplied_cents,
          order_total_cents = EXCLUDED.order_total_cents,
          deposit_cents     = EXCLUDED.deposit_cents,
          computed_at       = EXCLUDED.computed_at
        WHERE omp.applied_cents     IS DISTINCT FROM EXCLUDED.applied_cents
           OR omp.order_only_cents  IS DISTINCT FROM EXCLUDED.order_only_cents
           OR omp.unapplied_cents   IS DISTINCT FROM EXCLUDED.unapplied_cents
           OR omp.order_total_cents IS DISTINCT FROM EXCLUDED.order_total_cents
           OR omp.deposit_cents     IS DISTINCT FROM EXCLUDED.deposit_cents;

        -- Downstream mirror. Dollars, because that is what every existing
        -- consumer of these keys expects.
        --
        -- NOTE: no backticks in these comments. A backtick inside a SQL comment
        -- embedded in a JS template literal closes the string and breaks the
        -- parse -- a gotcha this repo has already paid for twice.
        --
        -- BOTH numbers are mirrored on purpose. referential_deposit keeps its
        -- name so the POS list, order detail, print templates and estimates
        -- keep working untouched; applied_total is what Paid Amt reads.
        -- Mirroring the pair here means no reader needs a new query and the
        -- Meili doc needs no enrichment step: query.graph already carries the
        -- metadata column, so both values ride along for free.
        v_mirror  := round(v_deposit / 100.0, 2);
        v_applied_d := round(v_applied / 100.0, 2);

        UPDATE "order"
        SET metadata = jsonb_set(
              jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{referential_deposit}',
                to_jsonb(v_mirror)
              ),
              '{applied_total}',
              to_jsonb(v_applied_d)
            ),
            updated_at = now()
        WHERE id = p_order_id
          AND (
            -- ABSENT is not ZERO. The previous guard compared
            -- COALESCE(metadata->>'applied_total', 0) against the new value, so
            -- an order with applied = 0 and no key compared 0 against 0, read
            -- "unchanged", and the key was never created. 325 orders ended up
            -- without it, 5 of them holding a live deposit -- and a reader that
            -- cannot find applied_total falls back to Medusa's captured amount,
            -- which re-derives the money this projection had just set to 0.
            -- That is the double count showing up as In Deposit == Paid Amt.
            NOT (COALESCE(metadata, '{}'::jsonb) ? 'referential_deposit')
            OR NOT (COALESCE(metadata, '{}'::jsonb) ? 'applied_total')
            OR round(COALESCE(NULLIF(metadata->>'referential_deposit', '')::numeric, 0), 2)
              IS DISTINCT FROM v_mirror
            OR round(COALESCE(NULLIF(metadata->>'applied_total', '')::numeric, 0), 2)
              IS DISTINCT FROM v_applied_d
          );
      END;
      $$ LANGUAGE plpgsql
    `;
