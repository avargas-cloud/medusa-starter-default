import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDocumentSequences1774279172000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Start Estimates at 1000
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS custom_estimate_seq START 1000;`
    );

    // Start Orders at 10000 (distinctly different length to instantly recognize)
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS custom_order_seq START 10000;`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE IF EXISTS custom_estimate_seq;`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS custom_order_seq;`);
  }
}
