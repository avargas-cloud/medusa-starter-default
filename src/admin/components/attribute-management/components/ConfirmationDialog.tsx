import { Prompt } from "@medusajs/ui"

type ConfirmationDialogProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    description: string
    confirmText?: string
    cancelText?: string
    onConfirm: () => void
}

/**
 * Custom confirmation dialog using Medusa UI Prompt
 * Replaces native window.confirm() with better UX
 */
export const ConfirmationDialog = ({
    open,
    onOpenChange,
    title,
    description,
    confirmText = "Continue",
    cancelText = "Cancel",
    onConfirm
}: ConfirmationDialogProps) => {
    const handleConfirm = () => {
        onConfirm()
        onOpenChange(false)
    }

    return (
        <Prompt open={open} onOpenChange={onOpenChange}>
            <Prompt.Content>
                <Prompt.Header>
                    <Prompt.Title>{title}</Prompt.Title>
                    <Prompt.Description>{description}</Prompt.Description>
                </Prompt.Header>
                <Prompt.Footer>
                    <Prompt.Cancel onClick={() => onOpenChange(false)}>
                        {cancelText}
                    </Prompt.Cancel>
                    <Prompt.Action onClick={handleConfirm}>
                        {confirmText}
                    </Prompt.Action>
                </Prompt.Footer>
            </Prompt.Content>
        </Prompt>
    )
}
