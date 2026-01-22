import { MigrationInterface, QueryRunner, TableColumn } from "typeorm"

export class AddThumbnailToProductCategory1737526800000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            "product_category",
            new TableColumn({
                name: "thumbnail",
                type: "text",
                isNullable: true,
            })
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn("product_category", "thumbnail")
    }
}
