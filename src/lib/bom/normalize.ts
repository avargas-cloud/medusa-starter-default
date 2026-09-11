import {
  CART_LINK_KEYS,
  LINE_PROVENANCE_KEYS,
  MAX_BOM_LINES,
  SyncCartBomError,
  type BomApp,
  type BomLineInput,
  type NormalizedBomLine,
} from "./types";

/**
 * Parte PURA del sync: validar, deduplicar y etiquetar. Todo lo que se puede
 * afirmar sin base vive acá (y en su unit spec).
 */
export function sourceKeyFor(app: BomApp, projectId: string, sku: string): string {
  return `${app}:${projectId}:${sku}`;
}

/**
 * Un BOM válido: SKUs no vacíos, cantidades enteras positivas, sin repetir
 * (dos líneas del mismo SKU se SUMAN — el motor puede emitir el mismo
 * conector para dos zonas), y con techo de líneas. El orden de entrada se
 * conserva para que el carrito se lea como el BOM.
 */
export function normalizeBomLines(
  app: BomApp,
  projectId: string,
  lines: BomLineInput[]
): NormalizedBomLine[] {
  if (!Array.isArray(lines)) {
    throw new SyncCartBomError(400, "INVALID_BOM", "lines must be an array");
  }
  if (lines.length > MAX_BOM_LINES) {
    throw new SyncCartBomError(400, "INVALID_BOM", `at most ${MAX_BOM_LINES} lines`);
  }
  const bySku = new Map<string, NormalizedBomLine>();
  for (const raw of lines) {
    const sku = typeof raw?.sku === "string" ? raw.sku.trim() : "";
    const quantity = Number(raw?.quantity);
    if (!sku) throw new SyncCartBomError(400, "INVALID_BOM", "every line needs a sku");
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new SyncCartBomError(400, "INVALID_BOM", `invalid quantity for ${sku}`);
    }
    const existing = bySku.get(sku);
    if (existing) {
      existing.quantity += quantity;
    } else {
      bySku.set(sku, { sku, quantity, sourceKey: sourceKeyFor(app, projectId, sku) });
    }
  }
  return [...bySku.values()];
}

/** Metadata de UNA línea del carrito: quién la puso y por qué. */
export function lineProvenance(
  app: BomApp,
  projectId: string,
  line: NormalizedBomLine
): Record<string, string> {
  return {
    [LINE_PROVENANCE_KEYS.app]: app,
    [LINE_PROVENANCE_KEYS.projectId]: projectId,
    [LINE_PROVENANCE_KEYS.key]: line.sourceKey,
    sku: line.sku,
  };
}

/**
 * Lo que se escribe en `cart.metadata` y hereda la orden al completar
 * (`completeCartWorkflow` copia `cart.metadata`): las mismas claves que el POS
 * escribe con set-bl-link / set-ll-link, así el candado, el POS y la web leen
 * UN solo vínculo.
 */
export function cartLinkMetadata(
  app: BomApp,
  projectId: string,
  projectSeq: string | null | undefined,
  now: Date = new Date()
): Record<string, unknown> {
  const keys = CART_LINK_KEYS[app];
  return {
    [keys.id]: projectId,
    [keys.seq]: projectSeq ?? null,
    [keys.linkedAt]: now.toISOString(),
    [keys.linkedBy]: "web",
    bom_source_app: app,
  };
}
