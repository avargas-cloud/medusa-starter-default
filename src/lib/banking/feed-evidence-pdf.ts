/**
 * PDF mínimo de texto (Courier 9pt, varias páginas): la evidencia GENERADA de un extracto cuyas
 * líneas salen del feed de Plaid (no hay PDF del banco que homologar). Vivía en
 * `reconcile-feed-statement.ts`; el job de sugerencias crea el borrador del mes con la misma
 * evidencia (2026-09-15).
 */
/** PDF mínimo de texto (Courier 9pt, varias páginas) — evidencia generada del feed. */
export function feedPdf(title: string, lines: string[]): Buffer {
  const esc = (s: string): string =>
    s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, (m) => `\\${m}`);
  const perPage = 60,
    pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage)
    pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([]);
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const pageIds: number[] = [];
  const pagesId = objects.length + pages.length * 2 + 1;
  for (const page of pages) {
    const text = [
      "BT /F1 9 Tf 36 770 Td 11 TL",
      `(${esc(title)}) Tj T*`,
      ...page.map((l) => `(${esc(l)}) Tj T*`),
      "ET",
    ].join("\n");
    const stream = add(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`
      )
    );
  }
  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");
  const pagesObj = add(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`);
  if (pagesObj !== pagesId) throw new Error("pdf object numbering");
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

