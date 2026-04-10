/**
 * Extract sales rep initials from order metadata.
 *
 * Handles both formats:
 *  - Legacy string: "AVP" or "Alejandro Vargas"
 *  - New object:    { initials: "AVP", name: "Alejandro Vargas" }
 */
export function parseSalesRepInitials(
    raw: unknown
): string | undefined {
    if (!raw) return undefined
    if (typeof raw === 'string') return raw
    if (typeof raw === 'object' && raw !== null && 'initials' in raw) {
        return (raw as { initials: string }).initials
    }
    return undefined
}
