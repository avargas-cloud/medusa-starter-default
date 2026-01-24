import { useCallback } from 'react'

type AttributeValue = {
    id: string
    value: string
    attribute_key: {
        id: string
        label: string
        handle: string
    }
}

/**
 * Hook to manage attribute operations (add, remove, toggle)
 */
export const useAttributeActions = (
    tempAttributes: AttributeValue[],
    setTempAttributes: (attrs: AttributeValue[]) => void,
    variantFlags: Record<string, boolean>,
    setVariantFlags: (flags: Record<string, boolean>) => void
) => {
    /**
     * Adds a new attribute value to the selection
     */
    const addAttribute = useCallback((newAttr: AttributeValue) => {
        setTempAttributes([...tempAttributes, newAttr])
    }, [tempAttributes, setTempAttributes])

    /**
     * Removes an attribute value from the selection
     */
    const removeAttribute = useCallback((attrId: string) => {
        const removed = tempAttributes.find(a => a.id === attrId)
        const newAttrs = tempAttributes.filter(a => a.id !== attrId)
        setTempAttributes(newAttrs)

        // If this was the last value for this key, disable variant flag
        if (removed) {
            const remainingForKey = newAttrs.filter(
                a => a.attribute_key.id === removed.attribute_key.id
            )
            if (remainingForKey.length === 0) {
                const newFlags = { ...variantFlags }
                delete newFlags[removed.attribute_key.id]
                setVariantFlags(newFlags)
            }
        }
    }, [tempAttributes, setTempAttributes, variantFlags, setVariantFlags])

    /**
     * Toggles variant flag for a key
     */
    const toggleVariant = useCallback((keyId: string, enabled: boolean) => {
        setVariantFlags({
            ...variantFlags,
            [keyId]: enabled
        })
    }, [variantFlags, setVariantFlags])

    return {
        addAttribute,
        removeAttribute,
        toggleVariant
    }
}
