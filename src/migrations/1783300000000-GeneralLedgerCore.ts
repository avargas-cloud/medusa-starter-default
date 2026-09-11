import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * gl-core-v1 — plan §§1-4 (docs/GENERAL_LEDGER_PLAN.md). Agrega la familia
 * `document` al journal existente de Banking (bank_journal_entry/
 * bank_journal_line) en vez de crear un segundo libro: mismos centavos
 * `bigint`, mismo trigger de inmutabilidad, mismo balance diferido. Ningún
 * kind existente (legacy v8/v9 ni completion v11) cambia de comportamiento —
 * los dos únicos triggers legacy que necesitan un WHEN más estricto se
 * recrean con el MISMO cuerpo (`bank_journal_claim_source`,
 * `bank_journal_check_balance`) y las dos funciones de completion que ya
 * distinguían por `completion_id` ganan `source_kind IS NULL`.
 *
 * Expand-only: ningún DROP de columna/tabla preexistente; `down()` retira
 * sólo lo que esta migración agrega y restaura los WHEN/CHECK originales.
 */
export class GeneralLedgerCore1783300000000 implements MigrationInterface {
  name = "GeneralLedgerCore1783300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guard (2026-09-10): el journal del GL ES el de Banking. En producción el módulo
    // Banking sólo se registra con BANKING_ENABLED=true, y sin registro sus migraciones
    // nunca crean bank_journal_entry. Fallar ACÁ, ruidoso y antes de tocar nada, deja el
    // predeploy de Railway en rojo con el build viejo ACTIVE — mejor que un GL a medias.
    const guardRows = (await queryRunner.query(
      `SELECT to_regclass('public.bank_journal_entry') IS NOT NULL AS present`
    )) as Array<{ present: boolean }>;
    if (!guardRows[0]?.present) {
      throw new Error(
        "GeneralLedger migration: falta bank_journal_entry. Registrá el módulo Banking " +
          "(BANKING_ENABLED=true) para que sus migraciones corran ANTES (medusa db:migrate " +
          "precede a run-custom-migrations.js), y re-desplegá."
      );
    }
    // ── §3: qb_account gana account_number/parent_list_id/normal_balance ──
    await queryRunner.query(`
      ALTER TABLE qb_account
        ADD COLUMN IF NOT EXISTS account_number text,
        ADD COLUMN IF NOT EXISTS parent_list_id text,
        ADD COLUMN IF NOT EXISTS normal_balance text
    `);
    await queryRunner.query(
      `ALTER TABLE qb_account DROP CONSTRAINT IF EXISTS qb_account_normal_balance_check`
    );
    await queryRunner.query(`
      ALTER TABLE qb_account ADD CONSTRAINT qb_account_normal_balance_check
        CHECK (normal_balance IN ('debit','credit'))
    `);
    // Backfill de las filas existentes; NonPosting (y cualquier tipo no listado) queda NULL.
    await queryRunner.query(`
      UPDATE qb_account SET normal_balance = CASE account_type
        WHEN 'Bank' THEN 'debit' WHEN 'AccountsReceivable' THEN 'debit' WHEN 'OtherCurrentAsset' THEN 'debit'
        WHEN 'FixedAsset' THEN 'debit' WHEN 'OtherAsset' THEN 'debit' WHEN 'Expense' THEN 'debit'
        WHEN 'OtherExpense' THEN 'debit' WHEN 'CostOfGoodsSold' THEN 'debit'
        WHEN 'AccountsPayable' THEN 'credit' WHEN 'CreditCard' THEN 'credit' WHEN 'OtherCurrentLiability' THEN 'credit'
        WHEN 'LongTermLiability' THEN 'credit' WHEN 'Equity' THEN 'credit' WHEN 'Income' THEN 'credit'
        WHEN 'OtherIncome' THEN 'credit' ELSE NULL END
      WHERE normal_balance IS NULL
    `);

    // ── §3: mapa de cuentas del GL ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS gl_account_map (
        key                text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
        qb_list_id         text NOT NULL,
        account_snapshot   jsonb NOT NULL,
        allowed_types      text[] NOT NULL,
        label              text NOT NULL,
        updated_by         text NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ── §4: columnas nuevas del journal (discriminador de la familia document) ──
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry
        ADD COLUMN IF NOT EXISTS source_kind text,
        ADD COLUMN IF NOT EXISTS source_id text,
        ADD COLUMN IF NOT EXISTS document_number text,
        ADD COLUMN IF NOT EXISTS posted_by text
    `);
    await queryRunner.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check`
    );
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_entry_source_kind_check
        CHECK (source_kind IN ('pos_invoice','pos_credit_memo','customer_payment','rounding_adjustment'))
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_entry_source ON bank_journal_entry(source_kind, source_id)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_entry_day ON bank_journal_entry(day) WHERE source_kind IS NOT NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_gl_line_account ON bank_journal_line(account_list_id, entry_id)`
    );

    // kind: + 'document'
    await queryRunner.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_kind`
    );
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_kind CHECK (kind IN
        ('expense','receipt','deposit','payment_match','reversal','movement','merchant_settlement','merchant_receipt','document'))
    `);

    // completion_shape: 3 ramas (legacy / completion / document). Las dos ramas
    // preexistentes ganan `AND source_kind IS NULL`; la tercera es nueva.
    await queryRunner.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_completion_shape`
    );
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_completion_shape CHECK (
        (completion_id IS NULL AND completion_stage IS NULL AND source_kind IS NULL
          AND kind NOT IN ('movement','merchant_settlement','merchant_receipt','document'))
        OR (completion_id IS NOT NULL AND length(trim(completion_id))>0 AND completion_stage IS NOT NULL
          AND length(trim(completion_stage))>0 AND source_kind IS NULL
          AND kind IN ('movement','merchant_settlement','merchant_receipt','reversal')
          AND expense_id IS NULL AND receipt_id IS NULL AND deposit_id IS NULL)
        OR (source_kind IS NOT NULL AND length(trim(source_id))>0 AND completion_id IS NULL AND completion_stage IS NULL
          AND kind IN ('document','reversal') AND expense_id IS NULL AND receipt_id IS NULL AND deposit_id IS NULL
          AND transaction_id IS NULL)
      )
    `);

    // Triggers legacy: mismo cuerpo, WHEN más estricto (+ source_kind IS NULL).
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_journal_source_claim ON bank_journal_entry`
    );
    await queryRunner.query(`
      CREATE TRIGGER bank_journal_source_claim BEFORE INSERT ON bank_journal_entry FOR EACH ROW
        WHEN (NEW.completion_id IS NULL AND NEW.source_kind IS NULL) EXECUTE FUNCTION bank_journal_claim_source()
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_journal_entry_balance ON bank_journal_entry`
    );
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER bank_journal_entry_balance AFTER INSERT ON bank_journal_entry
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW.completion_id IS NULL AND NEW.source_kind IS NULL) EXECUTE FUNCTION bank_journal_check_balance()
    `);
    // bank_journal_line_balance no se toca: su WHEN llama bank_completion_is_legacy(entry_id),
    // así que CREATE OR REPLACE de esa función alcanza (mismo OID, la referencia no se inlinea).

    // bank_completion_is_legacy(): + source_kind IS NULL.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION bank_completion_is_legacy(target text) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT COALESCE((SELECT completion_id IS NULL AND source_kind IS NULL FROM bank_journal_entry WHERE id=target),true)
      $$
    `);

    // bank_completion_claim_insert(): acepta entradas con source_kind IS NOT NULL (sigue rechazando kind='reversal').
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION bank_completion_claim_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE e bank_journal_entry%ROWTYPE;
      BEGIN
        SELECT * INTO e FROM bank_journal_entry WHERE id=NEW.entry_id;
        IF (e.completion_id IS NULL AND e.source_kind IS NULL) OR e.kind='reversal'
          THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
        PERFORM bank_completion_validate_claim(NEW.source_kind,NEW.source_id,NEW.amount_cents,NEW.capacity_cents,NEW.source_hash,NEW.entry_id);
        RETURN NEW;
      END $$
    `);

    // ── familia document: helper para el WHEN de gl_document_line_balance ──
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gl_document_is_document(target text) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT COALESCE((SELECT source_kind IS NOT NULL FROM bank_journal_entry WHERE id=target), false)
      $$
    `);

    // gl_document_source_unique: un documento = una entrada activa por (source_kind, source_id).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gl_document_source_unique() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE original bank_journal_entry%ROWTYPE;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
        IF NEW.kind='reversal' THEN
          SELECT * INTO original FROM bank_journal_entry WHERE id=NEW.reverses_entry_id;
          IF original.id IS NULL OR original.kind<>'document' OR original.source_kind IS DISTINCT FROM NEW.source_kind
            OR original.source_id IS DISTINCT FROM NEW.source_id OR original.amount_cents<>NEW.amount_cents
            OR original.source_hash<>NEW.source_hash OR original.source_snapshot<>NEW.source_snapshot OR NEW.day<original.day
          THEN RAISE EXCEPTION 'GL_SOURCE_INVALID'; END IF;
          IF EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=original.id)
            THEN RAISE EXCEPTION 'GL_ALREADY_POSTED'; END IF;
        ELSE
          IF EXISTS(SELECT 1 FROM bank_journal_entry e WHERE e.source_kind=NEW.source_kind AND e.source_id=NEW.source_id
            AND e.kind='document' AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
            THEN RAISE EXCEPTION 'GL_ALREADY_POSTED'; END IF;
        END IF;
        RETURN NEW;
      END $$
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS gl_document_source_unique ON bank_journal_entry`
    );
    await queryRunner.query(`
      CREATE TRIGGER gl_document_source_unique BEFORE INSERT ON bank_journal_entry FOR EACH ROW
        WHEN (NEW.source_kind IS NOT NULL) EXECUTE FUNCTION gl_document_source_unique()
    `);

    // gl_document_check_balance: constraint trigger diferida sobre entry y sobre line.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gl_document_check_balance() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE entry bank_journal_entry%ROWTYPE; target text; n integer; deb numeric; cred numeric;
      BEGIN
        IF TG_TABLE_NAME='bank_journal_entry' THEN target:=NEW.id; ELSE target:=NEW.entry_id; END IF;
        SELECT * INTO entry FROM bank_journal_entry WHERE id=target;
        IF entry.source_kind IS NULL THEN RETURN NULL; END IF;
        SELECT COUNT(*),COALESCE(SUM(debit_cents),0),COALESCE(SUM(credit_cents),0) INTO n,deb,cred
          FROM bank_journal_line WHERE entry_id=target;
        IF n<2 OR n>200 OR deb<>cred OR deb<>entry.amount_cents
          OR EXISTS(SELECT 1 FROM bank_journal_line l WHERE l.entry_id=target AND (
            (l.debit_cents>0)=(l.credit_cents>0)
            OR l.account_list_id IS DISTINCT FROM l.account_snapshot->>'id'
            OR l.account_snapshot->>'account_type'='NonPosting'
            OR l.account_snapshot->>'currency' IS DISTINCT FROM 'USD'))
        THEN RAISE EXCEPTION 'GL_UNBALANCED_DOCUMENT'; END IF;
        IF entry.kind='reversal' THEN
          IF EXISTS(SELECT 1 FROM (SELECT * FROM bank_journal_line WHERE entry_id=target) l FULL JOIN
              (SELECT * FROM bank_journal_line WHERE entry_id=entry.reverses_entry_id) o ON o.role=l.role
            WHERE (l.entry_id=target OR l.id IS NULL) AND (l.id IS NULL OR o.id IS NULL
              OR l.account_list_id<>o.account_list_id OR l.account_snapshot<>o.account_snapshot
              OR l.debit_cents<>o.credit_cents OR l.credit_cents<>o.debit_cents))
          THEN RAISE EXCEPTION 'GL_REVERSAL_INVALID'; END IF;
        END IF;
        RETURN NULL;
      END $$
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS gl_document_entry_balance ON bank_journal_entry`
    );
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER gl_document_entry_balance AFTER INSERT ON bank_journal_entry
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_kind IS NOT NULL)
        EXECUTE FUNCTION gl_document_check_balance()
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS gl_document_line_balance ON bank_journal_line`
    );
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER gl_document_line_balance AFTER INSERT ON bank_journal_line
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (gl_document_is_document(NEW.entry_id))
        EXECUTE FUNCTION gl_document_check_balance()
    `);

    // ── §3: seed de gl_account_map por full_name (bad_debt por ListID). Nunca
    // se inserta una fila para una key que no resuelva: la pantalla la muestra
    // en rojo y el posting con ese key falla GL_ACCOUNT_MAP_MISSING. ──
    const seeds: Array<{
      key: string;
      matchBy: "full_name" | "list_id";
      value: string;
      allowedTypes: string[];
      label: string;
    }> = [
      {
        key: "accounts_receivable",
        matchBy: "full_name",
        value: "Accounts Receivable",
        allowedTypes: ["AccountsReceivable"],
        label: "Accounts Receivable",
      },
      {
        key: "undeposited_funds",
        matchBy: "full_name",
        value: "Undeposited Funds",
        allowedTypes: ["OtherCurrentAsset"],
        label: "Undeposited Funds",
      },
      {
        key: "sales_tax_payable",
        matchBy: "full_name",
        value: "Sales Tax Payable",
        allowedTypes: ["OtherCurrentLiability"],
        label: "Sales Tax Payable",
      },
      {
        key: "inventory_asset",
        matchBy: "full_name",
        value: "Inventory Asset",
        allowedTypes: ["OtherCurrentAsset"],
        label: "Inventory Asset",
      },
      {
        key: "sales_discounts",
        matchBy: "full_name",
        value: "Sales:Sales Discounts",
        allowedTypes: ["Income"],
        label: "Sales Discounts",
      },
      {
        key: "shipping_income",
        matchBy: "full_name",
        value: "Sales:Shipping and Delivery Income",
        allowedTypes: ["Income"],
        label: "Shipping and Delivery Income",
      },
      {
        key: "income_default",
        matchBy: "full_name",
        value: "Sales",
        allowedTypes: ["Income"],
        label: "Sales",
      },
      {
        key: "cogs_default",
        matchBy: "full_name",
        value: "Purchases - Resale Items:Ecopowertech",
        allowedTypes: ["CostOfGoodsSold"],
        label: "Purchases - Resale Items:Ecopowertech",
      },
      {
        key: "bad_debt",
        matchBy: "list_id",
        value: "8000018C-1788546064",
        allowedTypes: ["Expense", "OtherExpense"],
        label: "Bad Debt / Fraud / Chargeback",
      },
    ];
    for (const seed of seeds) {
      const column = seed.matchBy === "full_name" ? "full_name" : "qb_list_id";
      await queryRunner.query(
        `
        INSERT INTO gl_account_map (key, qb_list_id, account_snapshot, allowed_types, label, updated_by)
        SELECT $1, a.qb_list_id,
          jsonb_build_object('id', a.qb_list_id, 'name', a.full_name, 'account_type', a.account_type, 'currency', 'USD'),
          $2::text[], $3, 'migration-1783300000000'
        FROM qb_account a
        WHERE a.${column} = $4 AND a.is_active = true AND a.account_type = ANY($2::text[])
        ORDER BY a.last_synced_at DESC LIMIT 1
        ON CONFLICT (key) DO NOTHING
      `,
        [seed.key, seed.allowedTypes, seed.label, seed.value]
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS gl_document_line_balance ON bank_journal_line`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS gl_document_entry_balance ON bank_journal_entry`
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS gl_document_check_balance()`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS gl_document_source_unique ON bank_journal_entry`
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS gl_document_source_unique()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS gl_document_is_document(text)`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION bank_completion_claim_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE e bank_journal_entry%ROWTYPE;
      BEGIN
        SELECT * INTO e FROM bank_journal_entry WHERE id=NEW.entry_id;
        IF e.completion_id IS NULL OR e.kind='reversal' THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
        PERFORM bank_completion_validate_claim(NEW.source_kind,NEW.source_id,NEW.amount_cents,NEW.capacity_cents,NEW.source_hash,NEW.entry_id);
        RETURN NEW;
      END $$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION bank_completion_is_legacy(target text) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT COALESCE((SELECT completion_id IS NULL FROM bank_journal_entry WHERE id=target),true)
      $$
    `);

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_journal_entry_balance ON bank_journal_entry`
    );
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER bank_journal_entry_balance AFTER INSERT ON bank_journal_entry
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.completion_id IS NULL) EXECUTE FUNCTION bank_journal_check_balance()
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_journal_source_claim ON bank_journal_entry`
    );
    await queryRunner.query(`
      CREATE TRIGGER bank_journal_source_claim BEFORE INSERT ON bank_journal_entry FOR EACH ROW
        WHEN (NEW.completion_id IS NULL) EXECUTE FUNCTION bank_journal_claim_source()
    `);

    await queryRunner.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_completion_shape`
    );
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_completion_shape CHECK (
        (completion_id IS NULL AND completion_stage IS NULL AND kind NOT IN ('movement','merchant_settlement','merchant_receipt'))
        OR (completion_id IS NOT NULL AND length(trim(completion_id))>0 AND completion_stage IS NOT NULL AND length(trim(completion_stage))>0
          AND kind IN ('movement','merchant_settlement','merchant_receipt','reversal') AND expense_id IS NULL AND receipt_id IS NULL AND deposit_id IS NULL)
      )
    `);
    await queryRunner.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_kind`
    );
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_kind CHECK (kind IN
        ('expense','receipt','deposit','payment_match','reversal','movement','merchant_settlement','merchant_receipt'))
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS idx_gl_line_account`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_gl_entry_day`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_gl_entry_source`);
    await queryRunner.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check`
    );
    await queryRunner.query(`
      ALTER TABLE bank_journal_entry
        DROP COLUMN IF EXISTS posted_by,
        DROP COLUMN IF EXISTS document_number,
        DROP COLUMN IF EXISTS source_id,
        DROP COLUMN IF EXISTS source_kind
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS gl_account_map`);

    await queryRunner.query(
      `ALTER TABLE qb_account DROP CONSTRAINT IF EXISTS qb_account_normal_balance_check`
    );
    await queryRunner.query(`
      ALTER TABLE qb_account
        DROP COLUMN IF EXISTS normal_balance,
        DROP COLUMN IF EXISTS parent_list_id,
        DROP COLUMN IF EXISTS account_number
    `);
  }
}
