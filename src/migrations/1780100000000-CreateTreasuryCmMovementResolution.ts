import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Accountant resolutions for credit-memo cross-category COGS movements.
 *
 * When a credit memo born from a return of one sourcing category (China/Local)
 * is redeemed against goods of the OTHER category, no new cash moves but a real
 * obligation to the other category's vendor is created — money parked in one
 * bank account should fund the other. Treasury surfaces this as a suggested
 * inter-bank movement (see load-cm-movements.ts). The accountant must resolve
 * every such row before a day can be Confirmed & Locked:
 *   - 'confirmed'      → apply the china↔local bank rebalance (audited).
 *   - 'ignored'        → acknowledged, no movement (reason required).
 *   - 'unattributable' → backing can't be determined (deleted/re-tagged/manual
 *                        credit) so no movement is possible (reason required).
 *
 * Movements themselves are derived LIVE while the day is open (never snapshotted
 * at credit issuance — store-pos is actively corrected day-to-day, so live picks
 * up data fixes). Only the DECISION is durable here. `derivation_hash` pins the
 * exact derived inputs the accountant saw; if the underlying items/costs/tags
 * change afterward the stored hash no longer matches the live derivation and the
 * UI shows the row as stale, forcing a re-confirm before the day can lock.
 *
 * One active resolution per redemption (payment_application_id UNIQUE); a
 * re-resolve is an UPSERT. At Confirm & Lock the resolved movements are copied
 * into treasury_distribution_log.snapshot_json (frozen forever); these rows stay
 * as the audit trail.
 */
export class CreateTreasuryCmMovementResolution1780100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS treasury_cm_movement_resolution (
        id                      TEXT PRIMARY KEY,
        payment_application_id  TEXT NOT NULL,
        resolution              TEXT NOT NULL
          CHECK (resolution IN ('confirmed', 'ignored', 'unattributable')),
        derivation_hash         TEXT NOT NULL,
        movement_json           JSONB NOT NULL,
        reason                  TEXT NULL,
        resolved_by_user_id     TEXT NULL,
        resolved_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_tcmr_payment_application_id UNIQUE (payment_application_id)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tcmr_payment_application_id
        ON treasury_cm_movement_resolution(payment_application_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_tcmr_payment_application_id`
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS treasury_cm_movement_resolution`
    );
  }
}
