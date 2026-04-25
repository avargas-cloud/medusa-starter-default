import * as path from "path";
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");

const EXCEL = path.join(__dirname, "../../../../", "Purchasing Analysis General 2026-04-22.xlsm");
const zip = new AdmZip(EXCEL);
const xml = zip.getEntry("xl/workbook.xml").getData().toString("utf8");
const parser = new XMLParser({ ignoreAttributes: false, isArray: (n: string) => n === "sheet" });
const wb = parser.parse(xml);
const sheets: Array<{ "@_name": string; "@_sheetId": string }> = wb?.workbook?.sheets?.sheet ?? [];
sheets.forEach((s) => console.log(`${s["@_sheetId"].padStart(3)} | ${s["@_name"]}`));
