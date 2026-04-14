/**
 * Extract sales rep initials from order metadata.
 *
 * Handles both formats:
 *  - Legacy string: "AVP" or "Alejandro Vargas" (full name → derived initials)
 *  - New object:    { initials: "AVP", name: "Alejandro Vargas" }
 *
 * QB rejects strings longer than ~5 chars in SalesRepRef/FullName.
 * If the value looks like a full name (contains a space), derive initials
 * by taking the first letter of each word.
 */
export function parseSalesRepInitials(
    raw: unknown
): string | undefined {
    if (!raw) return undefined
    if (typeof raw === 'object' && raw !== null && 'initials' in raw) {
        return (raw as { initials: string }).initials
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim()
        if (!trimmed) return undefined
        // If it contains a space it's a full name — derive initials from each word
        if (trimmed.includes(' ')) {
            return trimmed
                .split(/\s+/)
                .map(word => word[0]!.toUpperCase())
                .join('')
        }
        return trimmed
    }
    return undefined
}
