import "dotenv/config";
import fs from "fs";
import {
  bridgeFetch,
  pollRawOperationResult,
} from "../lib/quickbooks/client/core";

async function run() {
  console.log("Requesting Raw ItemQuery from Bridge...");
  try {
    const qbxml = `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="13.0"?>
<QBXML>
  <QBXMLMsgsRq onError="continueOnError">
    <ItemInventoryQueryRq>
      <!-- We ask for specific fields to see if bridge returns them, or just limit to 5 -->
      <MaxReturned>5</MaxReturned>
      <IncludeRetElement>Name</IncludeRetElement>
      <IncludeRetElement>FullName</IncludeRetElement>
      <IncludeRetElement>SalesPrice</IncludeRetElement>
      <IncludeRetElement>QuantityOnHand</IncludeRetElement>
      <IncludeRetElement>PurchaseCost</IncludeRetElement>
      <IncludeRetElement>PrefVendorRef</IncludeRetElement>
      <IncludeRetElement>Cost</IncludeRetElement>
    </ItemInventoryQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;

    // Try raw enqueue format if the bridge routes it correctly
    const payload = {
      type: "raw",
      action: "query",
      data: { qbxml },
    };

    const initRes = await bridgeFetch("POST", "/api/sync/enqueue", payload);
    const operationId =
      initRes.operationId || initRes.operation?.id || initRes.id;
    console.log(`✅ Operation Queued! ID: ${operationId}`);

    const result = await pollRawOperationResult(operationId);

    fs.writeFileSync(
      "/home/alejo/webapps/ecopowertech-workspace/backend/qb_raw_sync_output.json",
      JSON.stringify(result, null, 2)
    );
    console.log(`✅ Data Received! Saved to qb_raw_sync_output.json`);
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}

run();
