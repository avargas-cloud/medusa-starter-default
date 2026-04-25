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
const sheetXml = getSheetXml(zip, "12-Month-Sales");
const p = new XMLParser({ ignoreAttributes: false, isArray: (n: string) => n === "row" || n === "c" });
const sheet = p.parse(sheetXml);
const rows: any[] = sheet?.worksheet?.sheetData?.row ?? [];

// Print first 5 rows
rows.slice(0, 5).forEach((row: any, i: number) => {
  const cells: any[] = row.c ?? [];
  const vals = cells.slice(0, 20).map((c: any) => cellVal(c, shared).padEnd(18)).join(" | ");
  console.log(`Row ${i + 1}: ${vals}`);
});

console.log(`\nTotal rows: ${rows.length}`);
