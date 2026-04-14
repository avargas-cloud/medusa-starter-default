import { Modules } from "@medusajs/utils";
// En la v2 se requiere crear el item de inventario y luego vincularlo
// Para usar los links y módulos dentro de un script Medusa v2:
import { resolve } from "path";
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env") });

async function run() {
  process.exit(1); // Placeholder while figuring out standard medusa link mechanism for v2 script
}

run();
