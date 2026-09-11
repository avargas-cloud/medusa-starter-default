import {
  ORDER_METADATA_PROJECT_KEYS,
  type ProjectApp,
  type ProjectLink,
} from "./types";

/**
 * Vínculos proyecto↔orden leídos de `order.metadata`. Puro: la parte que se
 * puede probar sin base. El lado del PROYECTO (`estimate_id`) lo lee
 * `evaluate.ts` por SQL y se une acá con `mergeLinks`.
 */
export function linksFromOrderMetadata(
  metadata: Record<string, unknown> | null | undefined
): ProjectLink[] {
  if (!metadata || typeof metadata !== "object") return [];
  const links: ProjectLink[] = [];
  for (const app of Object.keys(ORDER_METADATA_PROJECT_KEYS) as ProjectApp[]) {
    const raw = metadata[ORDER_METADATA_PROJECT_KEYS[app].id];
    if (typeof raw === "string" && raw.trim()) {
      links.push({ app, projectId: raw.trim() });
    }
  }
  return links;
}

export function mergeLinks(...groups: ProjectLink[][]): ProjectLink[] {
  const seen = new Set<string>();
  const merged: ProjectLink[] = [];
  for (const group of groups) {
    for (const link of group) {
      const key = `${link.app}:${link.projectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(link);
    }
  }
  return merged;
}
