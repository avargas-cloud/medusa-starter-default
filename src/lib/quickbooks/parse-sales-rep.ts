/**
 * Extract sales rep initials from order metadata.
 *
 * Only accepts the object format: { initials: "AVP", name: "Alejandro Vargas" }
 * Returns undefined for plain strings or any other format — never derives
 * initials from a full name, because they may not match (e.g. "AVP" ≠ "AV").
 */
export function parseSalesRepInitials(raw: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "object" && raw !== null && "initials" in raw) {
    return (raw as { initials: string }).initials || undefined;
  }
  return undefined;
}
