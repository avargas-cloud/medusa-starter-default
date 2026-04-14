import { resolve } from "path";
import { config } from "dotenv";

config({ path: resolve(__dirname, "../../../.env") });

async function run() {
  console.log("Fetching order 1020 from local Admin API...");

  // 1. Authenticate to get a token
  const tokenRes = await fetch(
    "http://localhost:9000/admin/auth/user/emailpass",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Need admin credentials, maybe process.env has them or
      // We can just use the store API and look up by cart ID.
    }
  );

  // Alternatively, just query the DB using medusa modules.
}

run();
