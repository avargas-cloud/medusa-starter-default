import { initialize as initQuery } from "@medusajs/query";
import { Modules } from "@medusajs/utils";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  console.log("Modules:", Modules);
}
main();
