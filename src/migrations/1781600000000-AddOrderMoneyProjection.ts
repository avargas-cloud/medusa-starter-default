import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ONE truth for the money sitting on an order.
 *
 * WHY
 * ---
 * `order.metadata.referential_deposit` was a hand-maintained running total:
 * seven callsites incremented or decremented it, and unlink subtracted nothing
 * at all. One order read $18,917.94 against $2,141.71 of applied money. A
 * running total maintained by hand, mirroring something the database can
 * compute exactly, drifts by construction — every path has to remember, and
 * some never did. 1,182 of 1,220 orders disagreed with the money by 2026-07-29.
 *
 * The sibling case settles the design question: `qb_vendor`→Meili sync was
 * callsite-based and 5 of its 6 writers never called it. Maintenance by
 * callsite is the bug, not the cure.
 *
 * THE DEFINITIONS — they live here, once, and nowhere else
 * -------------------------------------------------------
 *   applied   = live applications pointing at the order (any source, credit
 *               memos included)
 *   unapplied = per payment ATTRIBUTED to the order, excluding payments whose
 *               status is voided or refunded:
 *                   GREATEST(0, payment.amount − that payment's live applications)
 *               Attribution is COALESCE(locked_order_id, metadata->>'order_id').
 *               Matching only the first is a documented mistake in this repo:
 *               six payments reach their order by metadata alone.
 *   total     = pos_total when > 0, else order_summary.current_order_total of
 *               the CURRENT version (an older version row carries the total
 *               from before the edit)
 *   deposit   = LEAST(unapplied, GREATEST(0, total − applied))
 *
 * `unapplied` subtracts a payment's applications to EVERY target, not just this
 * order: the remainder is what is left of the payment overall. Scoping it to
 * one order would count a dollar already spent on another order's invoice as
 * still available here.
 *
 * WHAT EACH NUMBER ANSWERS
 * ------------------------
 * `deposit` is money sitting on the order and NOT yet used. `applied` is money
 * already consumed by invoices — the POS shows it as Paid Amt. They are the
 * same money split in two, never overlapping. Applying a deposit moves value
 * from `deposit` to `applied` and does not change the sum. Voiding an
 * application moves it back: the money did not leave, it was un-imputed.
 * Refunding or voiding the PAYMENT is what removes it.
 *
 * Operator's rule, 2026-07-29: the deposit never exceeds the order. Pay $5,000
 * against a $4,000 order and only $4,000 is this order's deposit; the rest is an
 * unlinked payment for a future order. That rule is the CHECK constraint below —
 * not a convention the code is asked to respect, but a row Postgres refuses to
 * store. 18 orders were violating it when this shipped.
 *
 * FAIL-OPEN on an unreadable total: `deposit` is left unclamped rather than
 * clamped to zero, because clamping to a total you could not read turns a real
 * deposit into $0. Same posture as the reservation clamp's `total_unknown`.
 *
 * SUPERSEDES the 2026-05-08 rule ("external money only, never credits"). That
 * rule diagnosed a real bug — the same dollar counted twice, at capture and
 * again at application, which is why two orders sat at exactly 2.00x — but
 * prescribed the wrong cure. Credits were never the problem; double-counting
 * was, and deriving the value makes it impossible. Measured before shipping:
 * under the strict May reading, 59 settled orders would have started reading as
 * unpaid, because nothing in getPaidAmount() counts credit redemptions.
 *
 * WHY A TABLE AND NOT JUST METADATA
 * ---------------------------------
 * Finance truth inside mutable JSON cannot carry a constraint, and any write
 * path that rewrites `metadata` can clobber it. The typed row is the authority;
 * `order.metadata.referential_deposit` is kept as a DOWNSTREAM MIRROR so every
 * existing reader (POS list, order detail, build-order-doc, print templates,
 * estimates) keeps working unchanged.
 *
 * FOUR SOURCES, FOUR NARROW TRIGGERS
 *   payment_application  → `applied`, and `unapplied` through the remainder
 *   customer_payment     → `unapplied` (amount, status, attribution)
 *   order_summary        → the CLAMP, when the native total moves
 *   order (pos_total)    → the CLAMP, since pos_total outranks the summary
 *
 * Without the last two, an order edited DOWN strands its deposit above its own
 * total until the next payment happens to move — the very invariant this exists
 * to hold. The `order` trigger is self-referential by necessity (pos_total
 * lives in the same column the mirror writes) and terminates in two passes: it
 * returns immediately unless pos_total actually changed, and the recompute only
 * ever writes `referential_deposit`.
 *
 * Triggers cannot cover restores with triggers disabled, bulk imports, or
 * migrations. `recompute_all_order_money()` is the permanent backstop, run by
 * the daily digest.
 */
export class AddOrderMoneyProjection1781600000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Indexes the recompute leans on ────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payment_application_order_id_live"
      ON payment_application (order_id)
      WHERE deleted_at IS NULL AND voided_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_customer_payment_locked_order_id"
      ON customer_payment (locked_order_id)
      WHERE deleted_at IS NULL AND locked_order_id IS NOT NULL
    `);
    // Attribution by metadata is the fallback path; without this index every
    // recompute would seq-scan customer_payment.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_customer_payment_metadata_order_id"
      ON customer_payment ((metadata->>'order_id'))
      WHERE deleted_at IS NULL AND locked_order_id IS NULL
    `);

    // ── The authority ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS order_money_projection (
        order_id            text        PRIMARY KEY,
        -- Consumed by an invoice. This is Paid Amt.
        applied_cents       bigint      NOT NULL DEFAULT 0,
        -- Reserved against the ORDER with no invoice named (order-only
        -- applications). Money parked on the order — a deposit, not a payment.
        order_only_cents    bigint      NOT NULL DEFAULT 0,
        -- Remainder of payments attributed to the order that no application
        -- claims at all. Also a deposit.
        unapplied_cents     bigint      NOT NULL DEFAULT 0,
        order_total_cents   bigint      NOT NULL DEFAULT 0,
        deposit_cents       bigint      NOT NULL DEFAULT 0,
        calculator_version  integer     NOT NULL DEFAULT 1,
        computed_at         timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT "CHK_omp_applied_nonneg"    CHECK (applied_cents    >= 0),
        CONSTRAINT "CHK_omp_order_only_nonneg" CHECK (order_only_cents >= 0),
        CONSTRAINT "CHK_omp_unapplied_nonneg"  CHECK (unapplied_cents  >= 0),
        CONSTRAINT "CHK_omp_deposit_nonneg"    CHECK (deposit_cents    >= 0),

        -- THE CEILING, as law: the money on an order never exceeds the order.
        -- Deposit + applied <= total. Pay $5,000 against a $4,000 order and
        -- $4,000 is this order's deposit; the other $1,000 stays unlinked for a
        -- future order. A row that breaks this is not stored — it is the mistake
        -- that had Deposit and Paid Amt each showing the same $51 on a $54.57
        -- order, claiming $102 of money that did not exist.
        --
        -- Fails open on an unreadable total (<= 0): clamping to a total you could
        -- not read turns a real deposit into $0.
        -- Scoped to the deposit, which is the part this projection decides.
        -- It still delivers the ceiling: while applied <= total this forces
        -- applied + deposit <= total, and when invoices have ALREADY
        -- over-applied it forces deposit = 0, so the deposit never piles onto
        -- an order that is over its own total.
        --
        -- It cannot be written as "applied + deposit <= total" outright: 7 orders
        -- have invoices applying MORE than the order is worth (S10075 sits at
        -- exactly 2.00x from the apply_payment dual-key bug; the other six are
        -- 1-to-21-cent overages). That is a fact about their invoices, not about
        -- their deposit, and refusing to project them would just hide it.
        -- verify-orders-deposit-and-closure.ts axis 1 reports them for a human.
        CONSTRAINT "CHK_omp_ceiling_is_the_order" CHECK (
          order_total_cents <= 0
          OR deposit_cents <= GREATEST(0, order_total_cents - applied_cents)
        ),

        -- A deposit can never claim more money than is actually parked on the
        -- order: what is reserved against it plus what no application claims.
        CONSTRAINT "CHK_omp_deposit_within_money" CHECK (
          deposit_cents <= order_only_cents + unapplied_cents
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_omp_deposit_nonzero"
      ON order_money_projection (order_id) WHERE deposit_cents > 0
    `);

    // ── The one authoritative computation ─────────────────────────────────
    await queryRunner.query(`
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
            round(COALESCE(NULLIF(metadata->>'referential_deposit', '')::numeric, 0), 2)
              IS DISTINCT FROM v_mirror
            OR round(COALESCE(NULLIF(metadata->>'applied_total', '')::numeric, 0), 2)
              IS DISTINCT FROM v_applied_d
          );
      END;
      $$ LANGUAGE plpgsql
    `);

    // Permanent backstop for every path a trigger cannot see.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION recompute_all_order_money()
      RETURNS integer AS $$
      DECLARE
        v_id    text;
        v_count integer := 0;
      BEGIN
        FOR v_id IN SELECT id FROM "order" WHERE deleted_at IS NULL LOOP
          PERFORM recompute_order_money(v_id);
          v_count := v_count + 1;
        END LOOP;
        RETURN v_count;
      END;
      $$ LANGUAGE plpgsql
    `);

    // ── Narrow triggers: identify the affected orders, delegate the math ──
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trg_order_money_from_application()
      RETURNS TRIGGER AS $$
      DECLARE
        v_ids text[];
      BEGIN
        -- An application affects the order it points at AND the order its
        -- payment is attributed to; they are not always the same, and the
        -- remainder moves on both.
        v_ids := ARRAY[]::text[];
        IF TG_OP <> 'INSERT' THEN
          v_ids := v_ids || ARRAY[
            OLD.order_id,
            (SELECT COALESCE(locked_order_id, metadata->>'order_id')
               FROM customer_payment WHERE id = OLD.payment_id)
          ];
        END IF;
        IF TG_OP <> 'DELETE' THEN
          v_ids := v_ids || ARRAY[
            NEW.order_id,
            (SELECT COALESCE(locked_order_id, metadata->>'order_id')
               FROM customer_payment WHERE id = NEW.payment_id)
          ];
        END IF;

        PERFORM recompute_order_money(x)
        FROM (SELECT DISTINCT unnest(v_ids) AS x) s
        WHERE x IS NOT NULL;

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trg_order_money_from_payment()
      RETURNS TRIGGER AS $$
      DECLARE
        v_ids text[];
      BEGIN
        v_ids := ARRAY[]::text[];
        IF TG_OP <> 'INSERT' THEN
          v_ids := v_ids || ARRAY[COALESCE(OLD.locked_order_id, OLD.metadata->>'order_id')];
        END IF;
        IF TG_OP <> 'DELETE' THEN
          v_ids := v_ids || ARRAY[COALESCE(NEW.locked_order_id, NEW.metadata->>'order_id')];
        END IF;

        PERFORM recompute_order_money(x)
        FROM (SELECT DISTINCT unnest(v_ids) AS x) s
        WHERE x IS NOT NULL;

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trg_order_money_from_summary()
      RETURNS TRIGGER AS $$
      BEGIN
        PERFORM recompute_order_money(COALESCE(NEW.order_id, OLD.order_id));
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trg_order_money_from_order_total()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Exits here on every metadata write that is not a total change,
        -- including the mirror this function's own recompute writes. That is
        -- what makes the self-reference terminate in two passes.
        IF OLD.metadata->>'pos_total' IS NOT DISTINCT FROM NEW.metadata->>'pos_total' THEN
          RETURN NULL;
        END IF;
        PERFORM recompute_order_money(NEW.id);
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    for (const [name, table, events] of [
      [
        "trg_order_money_application",
        "payment_application",
        "AFTER INSERT OR UPDATE OR DELETE",
      ],
      [
        "trg_order_money_payment",
        "customer_payment",
        // `metadata` is in the list because attribution can live there. Ordinary
        // payment edits still land here, but the recompute's IS DISTINCT FROM
        // guards make an unchanged result cost reads, not writes.
        "AFTER INSERT OR DELETE OR UPDATE OF amount, status, locked_order_id, deleted_at, metadata",
      ],
      [
        "trg_order_money_summary",
        "order_summary",
        "AFTER INSERT OR UPDATE OR DELETE",
      ],
    ] as const) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS ${name} ON ${table}`
      );
      await queryRunner.query(`
        CREATE TRIGGER ${name}
        ${events} ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${
          table === "payment_application"
            ? "trg_order_money_from_application"
            : table === "customer_payment"
              ? "trg_order_money_from_payment"
              : "trg_order_money_from_summary"
        }()
      `);
    }

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_order_money_order_total ON "order"`
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_order_money_order_total
      AFTER UPDATE OF metadata ON "order"
      FOR EACH ROW EXECUTE FUNCTION trg_order_money_from_order_total()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_order_money_order_total ON "order"`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_order_money_summary ON order_summary`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_order_money_payment ON customer_payment`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_order_money_application ON payment_application`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS trg_order_money_from_order_total()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS trg_order_money_from_summary()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS trg_order_money_from_payment()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS trg_order_money_from_application()`
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS recompute_all_order_money()`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS recompute_order_money(text)`
    );
    await queryRunner.query(`DROP TABLE IF EXISTS order_money_projection`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_customer_payment_metadata_order_id"`
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_customer_payment_locked_order_id"`
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_payment_application_order_id_live"`
    );
  }
}
