/**
 * Groups flat attributes by their attribute key
 * Used to display attributes organized by key in the UI
 */
export const groupAttributesByKey = (flatAttributes: any[]) => {
    const groups: Record<string, any> = {}

    flatAttributes.forEach(attr => {
        const keyId = attr.attribute_key.id

        if (!groups[keyId]) {
            groups[keyId] = {
                key_id: keyId,
                key_title: attr.attribute_key.label || attr.attribute_key.title,
                key: attr.attribute_key, // full object
                values: []
            }
        }

        groups[keyId].values.push({
            id: attr.id,
            value: attr.value
        })
    })

    return Object.values(groups)
}

/**
 * Checks if a key has more available options that haven't been selected yet
 */
export const getKeyAvailability = (
    key: any | undefined,
    usedValues: any[]
) => {
    if (!key) return { hasMore: false }

    const usedCount = usedValues.filter(
        v => v.attribute_key.id === key.id
    ).length

    // Get all distinct options (from values + options array)
    const distinctOptions = new Set([
        ...(key.values?.map((v: any) => v.value) || []),
        ...(key.options || [])
    ])

    return { hasMore: distinctOptions.size > usedCount }
}
