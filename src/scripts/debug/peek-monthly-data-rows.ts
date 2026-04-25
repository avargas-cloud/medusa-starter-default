import * as path from "path";
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");

const EXCEL = path.join(__dirname, "../../../../", "Purchasing Analysis General 2026-04-22.xlsm");

function getSharedStrings(zip: any): string[] {
  const entry = zip.getEntry("xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = entry.getData().toString("utf8");
  const p = new XMLParser({ ignoreAttributes: false, isArray: (n: string) => n === "si" || n === "r" });
  const parsed = p.parse(xml);
  return (parsed?.sst?.si ?? []).map((si: any) => {
    if (typeof si.t === "string") return si.t;
    if (typeof si.t?.["#text"] === "string") return si.t["#text"];
    if (Array.isArray(si.r)) return si.r.map((r: any) => r.t?.["#text"] ?? r.t ?? "").join("");
    return "";
  });
}

function getSheetXml(zip: any, sheetName: string): string {
  const wbXml = zip.getEntry("xl/workbook.xml").getData().toString("utf8");
  const wbP = new XMLParser({ ignoreAttributes: false, isArray: (n: string) => n === "sheet" });
  const wb = wbP.parse(wbXml);
  const sheet = wb.workbook.sheets.sheet.find((s: any) => s["@_name"] === sheetName);
  const rId = sheet["@_r:id"];
  const relXml = zip.getEntry("xl/_rels/workbook.xml.rels").getData().toString("utf8");
  const relP = new XMLParser({ ignoreAttributes: false, isArray: (n: string) => n === "Relationship" });
  const rels = relP.parse(relXml);
  const rel = rels.Relationships.Relationship.find((r: any) => r["@_Id"] === rId);
  return zip.getEntry(`xl/${rel["@_Target"]}`).getData().toString("utf8");
}

function cellVal(cell: any, shared: string[]): string {
  const t = cell["@_t"];
  const v = cell.v !== undefined ? String(cell.v) : "";
  if (t === "s") return shared[parseInt(v, 10)] ?? "";
  return v;
}

const zip = new AdmZip(EXCEL);
const shared = getSharedStrings(zip);

// Sheet "1" = January 2026 — show rows 5-15 to see the data format
const xml = getSheetXml(zip, "1");
const p = new XMLParser({ ignoreAttributes: false, isArray: (n: string) => n === "row" || n === "c" });
const sheet = p.parse(xml);
const rows: any[] = sheet?.worksheet?.sheetData?.row ?? [];

console.log("Sheet 1 (January 2026) — rows 5-20:");
rows.slice(4, 20).forEach((row: any, i: number) => {
  const cells: any[] = row.c ?? [];
  const vals = cells.slice(0, 8).map((c: any) => {
    const ref = c["@_r"] ?? "";
    const val = cellVal(c, shared).slice(0, 25);
    return `${ref}:${val}`.padEnd(30);
  }).join(" | ");
  console.log(`  Row ${i + 6}: ${vals}`);
});

// Also show rows near the end (maybe there are totals)
console.log("\nLast 5 rows:");
rows.slice(-5).forEach((row: any) => {
  const cells: any[] = row.c ?? [];
  const vals = cells.slice(0, 6).map((c: any) => {
    const ref = c["@_r"] ?? "";
    const val = cellVal(c, shared).slice(0, 25);
    return `${ref}:${val}`.padEnd(30);
  }).join(" | ");
  console.log(`  ${vals}`);
});
