import { toast, Prompt } from "@medusajs/ui"
import { useQueryClient } from "@tanstack/react-query"


type DeleteSetModalProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    set: { id: string; title: string } | null
}

export const DeleteSetModal = ({ open, onOpenChange, set }: DeleteSetModalProps) => {
    const queryClient = useQueryClient()

    const handleDelete = async () => {
        if (!set) return

        try {
            const res = await fetch(`/admin/attribute-sets/${set.id}`, {
                method: "DELETE",
            })

            if (!res.ok) throw new Error("Failed to delete set")

            toast.success("Attribute set deleted", {
                description: `Deleted "${set.title}". Attributes moved to Unassigned.`,
            })

            queryClient.invalidateQueries({ queryKey: ["attribute-sets"] })
            queryClient.invalidateQueries({ queryKey: ["attributes"] })
            onOpenChange(false)
        } catch (err) {
            toast.error("Error", {
                description: (err as Error).message,
            })
        }
    }

    return (
        <Prompt open={open} onOpenChange={onOpenChange}>
            <Prompt.Content>
                <Prompt.Header>
                    <Prompt.Title>Delete Attribute Set?</Prompt.Title>
                    <Prompt.Description>
                        Are you sure you want to delete "{set?.title}"?
                        Attributes will NOT be deleted, they will be moved to "Unassigned".
                    </Prompt.Description>
                </Prompt.Header>
                <Prompt.Footer>
                    <Prompt.Cancel>Cancel</Prompt.Cancel>
                    <Prompt.Action onClick={handleDelete}>Delete</Prompt.Action>
                </Prompt.Footer>
            </Prompt.Content>
        </Prompt>
    )
}
