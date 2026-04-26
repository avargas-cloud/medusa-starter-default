import Database from "better-sqlite3";

const dbPath = "/home/alejo/webapps/quickbooks-bridge/data/database.sqlite";
const opId = "e36f48d5-5dce-4381-91c7-240f00fdb21d"; // The failed operation

try {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare("SELECT request_xml, payload FROM operation_queue WHERE id = ?")
    .get(opId);

  if (row) {
    console.log("=== EXACT XML STREAM ===");
    console.log(row.request_xml);
    console.log("\n=== PAYLOAD (IF ANY) ===");
    console.log(row.payload);
  } else {
    console.log("Operation not found in bridge DB.");
  }
  db.close();
} catch (err) {
  console.error(err);
}
