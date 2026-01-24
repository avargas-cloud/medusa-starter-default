import { useState } from 'react'

/**
 * Hook to manage confirmation dialog for disabling variant attributes
 * 
 * Handles:
 * - Detecting when variant keys are being removed/added
 * - Managing confirmation dialog state
 * - Proceeding with save only if confirmed
 */
export const useConfirmation = (
    initialVariantKeys: string[] | undefined,
    allKeys: any[]
) => {
    const [confirmationState, setConfirmationState] = useState<{
        isOpen: boolean
        title: string
        description: string
        onConfirm: (() => void) | null
    }>({
        isOpen: false,
        title: '',
        description: '',
        onConfirm: null
    })

    /**
     * Checks if save requires confirmation and either confirms or proceeds
     */
    const handleSaveWithConfirmation = async (
        variantFlags: Record<string, boolean>,
        onProceed: () => Promise<void>
    ): Promise<boolean> => {
        const previousKeys = initialVariantKeys || []
        const currentKeys = Object.keys(variantFlags).filter(k => variantFlags[k])
        const removedKeyIds = previousKeys.filter(k => !currentKeys.includes(k))
        const addedKeyIds = currentKeys.filter(k => !previousKeys.includes(k))

        // Show confirmation when DISABLING variant attributes
        if (removedKeyIds.length > 0) {
            const removedLabels = removedKeyIds.map(keyId => {
                const keyData = allKeys.find(k => k.id === keyId)
                return keyData?.label || "Unknown"
            }).join(", ")

            return new Promise((resolve) => {
                setConfirmationState({
                    isOpen: true,
                    title: '⚠️ Delete Variant Options',
                    description: `Disabling these variant attributes will PERMANENTLY DELETE all related options and variants:\n\n${removedLabels}\n\nThis action cannot be undone.`,
                    onConfirm: async () => {
                        await onProceed()
                        resolve(true)
                    }
                })
            })
        }

        // Show confirmation when ENABLING variant attributes
        if (addedKeyIds.length > 0) {
            const addedLabels = addedKeyIds.map(keyId => {
                const keyData = allKeys.find(k => k.id === keyId)
                return keyData?.label || "Unknown"
            }).join(", ")

            return new Promise((resolve) => {
                setConfirmationState({
                    isOpen: true,
                    title: '✨ Generate Variants',
                    description: `Enabling these as variant attributes will automatically generate product variants:\n\n${addedLabels}\n\nContinue?`,
                    onConfirm: async () => {
                        await onProceed()
                        resolve(true)
                    }
                })
            })
        }

        // No confirmation needed, proceed directly
        await onProceed()
        return true
    }

    const closeConfirmation = () => {
        setConfirmationState({
            isOpen: false,
            title: '',
            description: '',
            onConfirm: null
        })
    }

    return {
        handleSaveWithConfirmation,
        confirmationState,
        closeConfirmation
    }
}
