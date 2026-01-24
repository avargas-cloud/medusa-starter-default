/**
 * Validates if an attribute key has enough values to be used as a variant
 * 
 * Rule: Minimum 2 values required for variant attribute
 */
export const validateVariantEligibility = (
    keyId: string,
    tempAttributes: any[]
): { isEligible: boolean; valueCount: number; reason?: string } => {
    // Count how many values this key has in current selection
    const valuesForKey = tempAttributes.filter(
        attr => attr.attribute_key.id === keyId
    )

    const count = valuesForKey.length

    if (count < 2) {
        return {
            isEligible: false,
            valueCount: count,
            reason: `Need at least 2 values (currently has ${count})`
        }
    }

    return {
        isEligible: true,
        valueCount: count
    }
}

/**
 * Checks if a key should show the variant toggle
 * Only shows if there are 2 or more values selected
 */
export const shouldShowVariantToggle = (
    keyId: string,
    tempAttributes: any[]
): boolean => {
    const validation = validateVariantEligibility(keyId, tempAttributes)
    return validation.isEligible
}
