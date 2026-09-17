import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * pos-calendars-20260917 — Accounting → Calendar de gastos recurrentes.
 *
 * Dos tablas, y la separación es la decisión de diseño:
 *
 * · `recurring_expense_rule` — la DEFINICIÓN (renta el 1, seguro el 15, SaaS
 *   el 31 con política de fin de mes). Payee y cuentas se guardan por ListID
 *   de QuickBooks, igual que checks y journal entries.
 * · `recurring_expense_occurrence` — cada VENCIMIENTO materializado, con el
 *   monto y la tolerancia como SNAPSHOT: editar la renta futura no reescribe
 *   lo que se esperaba en marzo. `UNIQUE (rule_id, period_key)` hace que
 *   materializar sea idempotente — el job diario y el save de la regla pueden
 *   correr las veces que sea.
 *
 * `due_date` es DATE (día de negocio en ET, sin hora): un vencimiento no es
 * un instante, y guardarlo como medianoche UTC lo corre de día con el DST.
 * `overdue` NO es un estado guardado: se deriva al leer (expected + fecha
 * pasada), así no hace falta un cron que "venza" filas.
 *
 * El calendario NO contabiliza: ninguna FK a vendor_bill/gl_*; los campos
 * `matched_kind`/`matched_id` quedan para que el casador del Bank Feed enlace
 * el documento real en un plan aparte.
 */
export class RecurringExpenses20260917100000 implements MigrationInterface {
  name = "RecurringExpenses20260917100000";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS recurring_expense_rule (
        id                        text PRIMARY KEY,
        name                      text NOT NULL,
        payee_type                text NULL,
        payee_id                  text NULL,
        payee_name                text NULL,
        expense_account_list_id   text NULL,
        pay_from_account_list_id  text NULL,
        expected_amount_cents     bigint NOT NULL,
        amount_kind               text NOT NULL DEFAULT 'fixed',
        tolerance_cents           bigint NOT NULL DEFAULT 0,
        tolerance_pct             numeric(5,2) NOT NULL DEFAULT 0,
        frequency                 text NOT NULL,
        day_of_month              smallint NULL,
        weekday                   smallint NULL,
        month_of_year             smallint NULL,
        end_of_month_policy       text NOT NULL DEFAULT 'last_day',
        start_date                date NOT NULL,
        end_date                  date NULL,
        is_active                 boolean NOT NULL DEFAULT true,
        notes                     text NULL,
        created_by_user_id        text NOT NULL,
        updated_by_user_id        text NOT NULL,
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT rex_amount_positive CHECK (expected_amount_cents > 0),
        CONSTRAINT rex_amount_kind CHECK (amount_kind IN ('fixed','estimated')),
        CONSTRAINT rex_tolerance CHECK (tolerance_cents >= 0 AND tolerance_pct >= 0 AND tolerance_pct <= 100),
        CONSTRAINT rex_frequency CHECK (frequency IN ('weekly','biweekly','monthly','quarterly','yearly')),
        CONSTRAINT rex_dom CHECK (day_of_month IS NULL OR (day_of_month BETWEEN 1 AND 31)),
        CONSTRAINT rex_weekday CHECK (weekday IS NULL OR (weekday BETWEEN 0 AND 6)),
        CONSTRAINT rex_moy CHECK (month_of_year IS NULL OR (month_of_year BETWEEN 1 AND 12)),
        CONSTRAINT rex_eom CHECK (end_of_month_policy IN ('last_day','skip','next_business_day')),
        CONSTRAINT rex_dates CHECK (end_date IS NULL OR end_date >= start_date)
      )
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS recurring_expense_occurrence (
        id                     text PRIMARY KEY,
        rule_id                text NOT NULL REFERENCES recurring_expense_rule(id) ON DELETE CASCADE,
        period_key             text NOT NULL,
        due_date               date NOT NULL,
        expected_amount_cents  bigint NOT NULL,
        tolerance_cents        bigint NOT NULL DEFAULT 0,
        tolerance_pct          numeric(5,2) NOT NULL DEFAULT 0,
        status                 text NOT NULL DEFAULT 'expected',
        actual_amount_cents    bigint NULL,
        actual_date            date NULL,
        matched_kind           text NULL,
        matched_id             text NULL,
        note                   text NULL,
        updated_by_user_id     text NULL,
        created_at             timestamptz NOT NULL DEFAULT now(),
        updated_at             timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT rexo_status CHECK (status IN ('expected','paid','skipped')),
        CONSTRAINT uq_rexo_rule_period UNIQUE (rule_id, period_key)
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_rexo_due_date ON recurring_expense_occurrence (due_date)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS recurring_expense_occurrence`);
    await q.query(`DROP TABLE IF EXISTS recurring_expense_rule`);
  }
}
