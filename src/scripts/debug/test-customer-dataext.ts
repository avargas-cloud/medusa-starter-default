/**
 * Test: verificar que CustomerQueryRq ahora devuelve DataExtRet
 * después del fix en quickbooks-bridge (OwnerID=0 agregado).
 *
 * Uso: yarn medusa exec ./src/scripts/debug/test-customer-dataext.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import {
  bridgeFetch,
  pollRawOperationResult,
} from "../../lib/quickbooks/client/core";

async function run() {
  console.log("[test-dataext] Enqueuing customer.query (MaxReturned=5)...");

  const initRes = await bridgeFetch("POST", "/api/sync/enqueue", {
    type: "customer",
    action: "query",
    data: { MaxReturned: 5 },
  });

  const operationId =
    initRes.operation_id ||
    initRes.operationId ||
    initRes.operation?.id ||
    initRes.id;
  if (!operationId) {
    console.error("[test-dataext] ❌ No operationId returned:", initRes);
    process.exit(1);
  }
  console.log(`[test-dataext] ✅ Queued operation ${operationId}`);

  const raw = await pollRawOperationResult(operationId);

  const outPath = path.resolve(
    "/home/alejo/webapps/ecopowertech-workspace/backend/qb_customer_dataext_output.json"
  );
  fs.writeFileSync(outPath, JSON.stringify(raw, null, 2));
  console.log(`[test-dataext] 📄 Full response saved to ${outPath}`);

  const msgs = raw?.QBXML?.QBXMLMsgsRs || raw?.QBXMLMsgsRs || {};
  const customerRet = msgs?.CustomerQueryRs?.CustomerRet;
  const customers = Array.isArray(customerRet)
    ? customerRet
    : customerRet
    ? [customerRet]
    : [];

  console.log(`\n[test-dataext] 👥 Customers returned: ${customers.length}\n`);

  let withDataExt = 0;
  for (const c of customers) {
    const dataExt = c.DataExtRet;
    const list = Array.isArray(dataExt) ? dataExt : dataExt ? [dataExt] : [];
    if (list.length > 0) withDataExt++;

    console.log(`─── ${c.Name || c.FullName || c.ListID} ───`);
    console.log(`   ListID: ${c.ListID}`);
    if (list.length === 0) {
      console.log(`   DataExtRet: (none)`);
    } else {
      for (const d of list) {
        console.log(
          `   📌 ${d.DataExtName} = "${d.DataExtValue}" (${d.DataExtType}, owner=${d.OwnerID})`
        );
      }
    }
    console.log();
  }

  console.log(
    `[test-dataext] Summary: ${withDataExt}/${customers.length} customers with DataExtRet`
  );
  if (withDataExt === 0 && customers.length > 0) {
    console.log(
      `[test-dataext] ⚠️  0 customers with DataExt. Verifica que el bridge ya corrió con el fix (pull+build+restart) y que los customers del sample tienen Distribution Channel/other custom field seteado.`
    );
  }
}

export default async function () {
  try {
    await run();
  } catch (err) {
    console.error("[test-dataext] ❌", err);
    process.exit(1);
  }
}
