/**
 * src/modules/document-templates/generate-id.ts
 * Generates a ULID-compatible ID for document templates.
 */

export function generateId(): string {
    // Simple timestamp + random suffix to match 26-char ULID format
    const now = Date.now()
    const timeBase = now.toString(36).toUpperCase().padStart(10, '0')
    const rand = Math.random().toString(36).substring(2, 18).toUpperCase().padEnd(16, '0')
    return (timeBase + rand).substring(0, 26)
}
