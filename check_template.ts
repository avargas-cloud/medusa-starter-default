import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const templates = await prisma.documentTemplate.findMany({
    where: { doc_type: "statement" },
  });
  for (const t of templates) {
    console.log(`\n\n=== Template: ${t.name} (${t.id}) ===`);
    console.log(`Doc Type: ${t.doc_type}`);

    const layout = t.layout_data as any[];
    if (!layout) {
      console.log("No layout_data");
      continue;
    }

    console.log(`Layout blocks (${layout.length}):`);
    layout.forEach((b) => {
      console.log(
        ` - [${b.id}] type=${b.type} locked=${b.locked} hidden=${b.hidden} x=${b.x} y=${b.y} w=${b.width} h=${b.height}`
      );
    });

    console.log(
      `\nField Config (first few keys):`,
      Object.keys(t.field_config || {})
    );
    const fc = t.field_config as any;
    console.log(`Columns:`, fc?.columns?.length);
    console.log(`Summary Rows:`, fc?.summary_rows?.length);
  }
}
main().then(() => prisma.$disconnect());
