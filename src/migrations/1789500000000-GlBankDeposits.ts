import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * record-deposits-gl-20260915 — el depósito bancario del POS (`bank_deposit`)
 * es un documento del GL (`source_kind='bank_deposit'`), igual que
 * `gl_check`/`gl_transfer`: Record Deposits = Make Deposits de QuickBooks.
 *
 * Expand-only, en `bank_deposit` hay 0 filas en producción (2026-09-15):
 * 1. `bank_journal_entry_source_kind_check` += `'bank_deposit'` — la lista
 *    vigente se LEE del catálogo y se re-emite con la clave nueva, para no
 *    pisar kinds que otra migración haya agregado en paralelo (la lección de
 *    `BankingOnGlLedger`, que reemplazó el CHECK sin los kinds de compras).
 * 2. `bank_deposit.account_list_id` (ListID de QB de la cuenta destino = el
 *    `DepositToAccountRef` de QB). `account_id` (cuenta Plaid) pasa a nullable:
 *    los Deposits de QB a "Cash Register" / "Cash on Hand" no tienen feed y
 *    se adoptan igual. `bank_deposit.number` (`DEP-####`) con su contador.
 * 3. `bank_deposit_line`: la línea MANUAL (sin `payment_id`, sin partida de
 *    apertura) nunca fue insertable — el CHECK `bank_deposit_funding_source`
 *    exigía exactamente uno de payment/opening. Pasa a exactamente uno de
 *    payment/opening/manual. `manual_account_list_id` = cuenta origen de la
 *    línea manual (NULL = Undeposited Funds, el default de siempre). El monto
 *    de una línea puede ser negativo (refund de tarjeta neteado en el lote).
 * 4. `bank_opening_deposit_guard()` recreada: la línea manual no consume una
 *    partida de apertura (esa feature se retiró) — antes moría con
 *    `BANKING_OPENING_CONSUMPTION_INVALID`. Mismo nombre y firma.
 */
export class GlBankDeposits1789500000000 implements MigrationInterface {
  name = "GlBankDeposits1789500000000";

  public async up(q: QueryRunner): Promise<void> {
    // typeorm envuelve la migración en UNA transacción: si un lock no llega en
    // 15 s la migración falla limpia (deploy FAILED, prod intacta, re-push)
    // en vez de esperar detrás del pipeline de QB — regla 2026-09-14.
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    // 1. source_kind CHECK: unión de lo vigente + bank_deposit
    const rows = (await q.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'bank_journal_entry_source_kind_check' AND conrelid = 'bank_journal_entry'::regclass`
    )) as Array<{ def: string }>;
    const current = new Set(
      Array.from((rows[0]?.def ?? "").matchAll(/'([a-z_]+)'::text/g), (m) => m[1])
    );
    if (current.size === 0) {
      throw new Error(
        "GlBankDeposits1789500000000: bank_journal_entry_source_kind_check not found or unparsable — refusing to guess the kind list"
      );
    }
    current.add("bank_deposit");
    const list = [...current].map((k) => `'${k}'`).join(", ");
    await q.query(
      `ALTER TABLE bank_journal_entry DROP CONSTRAINT IF EXISTS bank_journal_entry_source_kind_check`
    );
    // NOT VALID + VALIDATE: el ADD no escanea la tabla bajo ACCESS EXCLUSIVE;
    // VALIDATE toma SHARE UPDATE EXCLUSIVE (no bloquea los writes del pipeline).
    await q.query(
      `ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_entry_source_kind_check CHECK (source_kind IN (${list})) NOT VALID`
    );
    await q.query(
      `ALTER TABLE bank_journal_entry VALIDATE CONSTRAINT bank_journal_entry_source_kind_check`
    );

    // 2. bank_deposit: destino por ListID, cuenta Plaid opcional, número
    await q.query(
      `ALTER TABLE bank_deposit ADD COLUMN IF NOT EXISTS account_list_id text, ADD COLUMN IF NOT EXISTS number text`
    );
    await q.query(
      `UPDATE bank_deposit d SET account_list_id = a.qb_list_id FROM bank_account a
        WHERE a.id = d.account_id AND d.account_list_id IS NULL AND a.qb_list_id IS NOT NULL`
    );
    await q.query(`ALTER TABLE bank_deposit ALTER COLUMN account_id DROP NOT NULL`);
    await q.query(
      `ALTER TABLE bank_deposit DROP CONSTRAINT IF EXISTS bank_deposit_target_required`
    );
    await q.query(
      `ALTER TABLE bank_deposit ADD CONSTRAINT bank_deposit_target_required CHECK (account_list_id IS NOT NULL OR account_id IS NOT NULL)`
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_deposit_number ON bank_deposit (number) WHERE number IS NOT NULL`
    );
    await q.query(
      `INSERT INTO document_number_counter (name, value) VALUES ('bank_deposit', 0) ON CONFLICT (name) DO NOTHING`
    );

    // 3. bank_deposit_line: la línea manual existe
    await q.query(
      `ALTER TABLE bank_deposit_line ADD COLUMN IF NOT EXISTS manual_account_list_id text`
    );
    await q.query(
      `ALTER TABLE bank_deposit_line DROP CONSTRAINT IF EXISTS bank_deposit_funding_source`
    );
    await q.query(
      `ALTER TABLE bank_deposit_line ADD CONSTRAINT bank_deposit_funding_source
         CHECK ((payment_id IS NOT NULL)::int + (opening_item_id IS NOT NULL)::int + (manual_reference IS NOT NULL)::int = 1)`
    );

    // 3b. una línea puede ser NEGATIVA (un ARRefundCreditCard neteado dentro del
    // lote de tarjetas del día, como lo hace QuickBooks); el total sigue > 0.
    await q.query(`ALTER TABLE bank_deposit_line DROP CONSTRAINT IF EXISTS bank_deposit_line_amount_check`);
    await q.query(`ALTER TABLE bank_deposit_line ADD CONSTRAINT bank_deposit_line_amount_check CHECK (amount::numeric <> 0::numeric)`);

    // 4. guard de partidas de apertura: la línea manual pasa
    await q.query(`CREATE OR REPLACE FUNCTION bank_opening_deposit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE item bank_opening_item%ROWTYPE; parent bank_opening_balance%ROWTYPE; BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
        IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
        -- record-deposits-gl-20260915: línea manual (banking-on-gl) — no hay partida que consumir.
        IF NEW.manual_reference IS NOT NULL AND NEW.opening_item_id IS NULL THEN RETURN NEW; END IF;
        IF NEW.payment_id IS NOT NULL THEN
          IF EXISTS(SELECT 1 FROM bank_opening_item oi JOIN bank_opening_balance b ON b.id=oi.opening_id
            WHERE oi.payment_id=NEW.payment_id AND b.status='adopted')
          THEN RAISE EXCEPTION 'BANKING_OPENING_PAYMENT_CLAIMED'; END IF;
        ELSE
          SELECT * INTO item FROM bank_opening_item WHERE id=NEW.opening_item_id;
          SELECT * INTO parent FROM bank_opening_balance WHERE id=item.opening_id;
          IF item.kind IS DISTINCT FROM 'uf_receipt' OR parent.status IS DISTINCT FROM 'adopted'
            OR bank_opening_reserved(item.id,NEW.deposit_id)+NEW.amount::numeric*100>item.amount_cents
          THEN RAISE EXCEPTION 'BANKING_OPENING_CONSUMPTION_INVALID'; END IF;
        END IF; RETURN NEW; END $$`);
  }

  public async down(): Promise<void> {
    throw new Error(
      "GlBankDeposits1789500000000: expand-only (columns nullable, CHECK widened, guard relaxed) — reviewed rollback only."
    );
  }
}
