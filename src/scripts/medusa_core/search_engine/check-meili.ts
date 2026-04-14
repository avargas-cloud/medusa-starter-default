import { MeiliSearch } from "meilisearch";
const client = new MeiliSearch({
  host: "http://localhost:7700",
  apiKey: "masterKey_12345",
}); // assuming default for dev
async function check() {
  const res = await client.index("customers").search("Jorge Carvajal");
  console.log(JSON.stringify(res.hits[0], null, 2));
}
check();
