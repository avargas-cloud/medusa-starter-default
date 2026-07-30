import fetch from "node-fetch";
import { requireBridgeUrl } from "../../lib/quickbooks/bridge-url";

const BRIDGE_URL = requireBridgeUrl();
const API_KEY = process.env.QB_API_KEY;

async function run() {
  console.log("Fetching EditSequence for customer...");

  // 1. Get EditSequence
  const queryXml = `<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?><QBXML><QBXMLMsgsRq onError="stopOnError"><CustomerQueryRq><ListID>8000004E-1342117388</ListID></CustomerQueryRq></QBXMLMsgsRq></QBXML>`;

  let res = await fetch(`${BRIDGE_URL}/api/sync/direct-query`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ qbxml: queryXml }),
  });

  let data = await res.json();
  let opId = data.operationId;
  console.log("Query queued:", opId);

  let editSeq = "";
  while (true) {
    await new Promise((r) => setTimeout(r, 5000));
    let status = await (
      await fetch(`${BRIDGE_URL}/api/sync/status/${opId}`, {
        headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
      })
    ).json();
    if (status?.operation?.status === "completed") {
      const match = status.operation.qbxmlResponse.match(
        /<EditSequence>([^<]+)<\/EditSequence>/
      );
      editSeq = match ? match[1] : "";
      break;
    } else if (status?.operation?.status === "failed") {
      console.error("Query failed", status.operation.error);
      return;
    }
    console.log("Waiting for query...");
  }

  console.log("EditSequence:", editSeq);

  // 2. Mod
  const modXml = `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="10.0"?>
<QBXML>
<QBXMLMsgsRq onError="stopOnError">
<CustomerModRq>
<CustomerMod>
<ListID>8000004E-1342117388</ListID>
<EditSequence>${editSeq}</EditSequence>
<CompanyName>EPT INC</CompanyName>
<FirstName>Alejandro</FirstName>
<LastName>Vargas</LastName>
<BillAddress>
<Addr1>2760 W 84th St</Addr1>
<City>Hialeah</City>
<State>FL</State>
<PostalCode>33016</PostalCode>
</BillAddress>
<ShipToAddress>
<Name>cuaddr_01KMGRCNS6HP49AH86NM8RKAB2</Name>
<Addr1>244 Nw 72nd</Addr1>
<Addr2>101</Addr2>
<City>Miami</City>
<State>FL</State>
<PostalCode>33016</PostalCode>
</ShipToAddress>
<Phone>7866238401</Phone>
<Email>a.vargas@ecopowertech.com</Email>
<CustomerTypeRef>
<FullName>Employee</FullName>
</CustomerTypeRef>
<PriceLevelRef>
<FullName>Wholesale</FullName>
</PriceLevelRef>
</CustomerMod>
</CustomerModRq>
</QBXMLMsgsRq>
</QBXML>`.replace(/\n/g, "");

  console.log("Queueing mod...", modXml.substring(0, 100) + "...");
  res = await fetch(`${BRIDGE_URL}/api/sync/direct-query`, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify({ qbxml: modXml }),
  });

  data = await res.json();
  opId = data.operationId;

  while (true) {
    await new Promise((r) => setTimeout(r, 5000));
    let status = await (
      await fetch(`${BRIDGE_URL}/api/sync/status/${opId}`, {
        headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
      })
    ).json();
    if (status?.operation?.status === "completed") {
      console.log("SUCCESS!", status.operation.qbxmlResponse.substring(0, 100));
      break;
    } else if (status?.operation?.status === "failed") {
      console.error("FAILED!", status.operation.error);
      break;
    }
    console.log("Waiting for mod...");
  }
}
run();
