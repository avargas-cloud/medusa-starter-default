import { Heading, Text } from "@medusajs/ui"
import { InlineShippingHandle } from "./InlineShipping"

interface Props {
    showNoShippingModal: boolean
    onClose: () => void
    onLocalPickup: () => void
    onChooseManually: () => void
    shippingRef: React.RefObject<InlineShippingHandle | null>
}

/** Modal shown when user tries to convert without a shipping method selected. */
export const NoShippingModal = ({ showNoShippingModal, onClose, onLocalPickup, onChooseManually }: Props) => {
    if (!showNoShippingModal) return null
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-ui-bg-base border border-ui-border-base rounded-xl shadow-2xl p-6 w-full max-w-md mx-4">
                <Heading level="h2" className="mb-2">No Shipping Method</Heading>
                <Text className="text-ui-fg-subtle mb-5 text-sm">
                    This order doesn't have a shipping method. Would you like to use{" "}
                    <strong>Miami Store Pickup ($0.00)</strong> as default, or choose a different option?
                </Text>
                <div className="flex flex-col gap-2">
                    <button
                        onClick={onLocalPickup}
                        className="w-full px-4 py-2.5 rounded-lg bg-ui-button-inverted text-ui-fg-on-inverted text-sm font-medium hover:opacity-90 transition-opacity"
                    >
                        🏪 Yes, use Miami Store Pickup ($0.00)
                    </button>
                    <button
                        onClick={onChooseManually}
                        className="w-full px-4 py-2.5 rounded-lg border border-ui-border-base text-ui-fg-base text-sm font-medium hover:bg-ui-bg-subtle transition-colors"
                    >
                        No, let me choose a shipping method
                    </button>
                    <button onClick={onClose} className="text-xs text-ui-fg-muted hover:underline mt-1">
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    )
}
