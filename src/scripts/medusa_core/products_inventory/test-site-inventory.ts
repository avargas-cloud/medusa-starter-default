import "dotenv/config";
declare const process: any;
declare const require: any;

const BRIDGE_URL =
  process.env.QUICKBOOKS_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY =
  process.env.QUICKBOOKS_BRIDGE_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";

// QB ListID for "Principal Warehouse"
const SITE_ID = "80000001-1331053531";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testSiteQuery() {
  console.log("=============================================");
  console.log("🧪 TEST: QB Bridge — Inventory Site Query");
  console.log("=============================================");
  console.log(`Endpoint: GET /api/products/site/${SITE_ID}`);
  console.log(`Target Site: Principal Warehouse`);
  console.log("---------------------------------------------\n");

  try {
    // 1. Queue Operation
    console.log("📡 1. Queuing operation in QB Bridge...");
    const initUrl = `${BRIDGE_URL}/api/products/site/${SITE_ID}`;
    const initRes = await fetch(initUrl, {
      headers: {
        "x-api-key": API_KEY,
        "bypass-tunnel-reminder": "true",
      },
    });

    if (!initRes.ok) {
      console.error(
        `❌ Error querying bridge: ${initRes.status} ${initRes.statusText}`
      );
      const text = await initRes.text();
      console.error(text);
      process.exit(1);
    }

    const initData = await initRes.json();
    console.log(
      `✅ Success! Operation Queued with ID: ${initData.operationId}`
    );

    // 2. Poll Status
    console.log(
      "\n⏳ 2. Polling for results (waiting for QB Web Connector)..."
    );
    let attempts = 0;
    const MAX_POLLS = 15; // ~3 minutes total wait time possible

    while (attempts < MAX_POLLS) {
      attempts++;
      process.stdout.write(`. `);
      await sleep(10000); // 10 seconds per poll

      const statusRes = await fetch(
        `${BRIDGE_URL}/api/sync/status/${initData.operationId}`,
        {
          headers: {
            "x-api-key": API_KEY,
            "bypass-tunnel-reminder": "true",
          },
        }
      );

      const statusData = await statusRes.json();

      if (!statusData.success || !statusData.operation) {
        console.log(`\n⚠️ Polling error: ${JSON.stringify(statusData)}`);
        continue;
      }

      const op = statusData.operation;

      if (op.status === "completed") {
        console.log(`\n\n🎉 Operation Completed!`);

        // 3. Inspect Data
        let items = [];
        const qbMsgsRs =
          op.result?.QBXML?.QBXMLMsgsRs || op.result?.QBXMLMsgsRs;
        if (qbMsgsRs) {
          const retArray = qbMsgsRs.ItemSitesQueryRs?.ItemSitesRet || [];
          items = Array.isArray(retArray) ? retArray : [retArray];
        }

        console.log(
          `\n📦 Received ${items.length} site inventory records from QuickBooks.\n`
        );

        if (items.length > 0) {
          console.log("getFirstItemStructure:");
          console.log(JSON.stringify(items[0], null, 2));

          // Find EAP-AS1-8S to verify (it will be under ItemInventoryRef)
          const eap = items.find(
            (i: any) => i.ItemInventoryRef?.FullName === "EAP-AS1-8S"
          );
          if (eap) {
            console.log("\n🔍 Found 'EAP-AS1-8S' (SKU-001):");
            console.log(`   - QuantityOnHand: ${eap.QuantityOnHand}`);
            console.log(
              `   - Is this the expected Principal Warehouse quantity?`
            );
          } else {
            console.log("\n⚠️ Sample item 'EAP-AS1-8S' not found in response.");
          }
        }

        // Salvar debug completo a un archivo para inspección
        const fs = require("fs");
        fs.writeFileSync(
          "test_qb_site_query_debug.json",
          JSON.stringify(op, null, 2)
        );
        console.log(
          "\n💾 Escribí la respuesta completa en 'test_qb_site_query_debug.json'"
        );

        process.exit(0);
      } else if (op.status === "failed") {
        console.log(`\n\n❌ Operation Failed in QuickBooks.`);
        console.error(`Error details: ${op.error}`);
        console.log(`\n--- QBXML ENVÍADO AL BRIDGE ---`);
        console.log(op.qbxmlRequest);
        console.log(`-------------------------------`);
        process.exit(1);
      }
    }

    console.log(
      "\n\n⏰ Timeout: Reached max polling attempts. Check Web Connector."
    );
  } catch (e: any) {
    console.error(`\n❌ Error en el script: ${e.message}`);
  }
}

testSiteQuery();
