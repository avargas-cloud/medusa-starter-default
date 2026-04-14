import { pollOperationResult } from "./src/lib/quickbooks/qb-bridge-client.ts";
export default async function myScript() {
  try {
    const fetch = require("node-fetch");
    const res = await fetch(
      "https://qb.eptbridge.com/api/sync/status/998f9cbe-d937-459f-8aaa-fbdffd20b37a",
      {
        headers: { "x-api-key": process.env.QB_API_KEY },
      }
    );
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(e);
  }
}
