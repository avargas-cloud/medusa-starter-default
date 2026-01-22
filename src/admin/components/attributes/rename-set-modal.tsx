import { Button, Input, Label, toast, FocusModal, Heading, Text } from "@medusajs/ui"
import { useState, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"

type RenameSetModalProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    set: { id: string; title: string } | null
}

export const RenameSetModal = ({ open, onOpenChange, set }: RenameSetModalProps) => {
    const [title, setTitle] = useState("")
    const [loading, setLoading] = useState(false)
    const queryClient = useQueryClient()

    useEffect(() => {
        if (set) setTitle(set.title)
    }, [set])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!set) return
        setLoading(true)

        try {
            const res = await fetch(`/admin/attribute-sets/${set.id}`, {
                method: "POST", // Changed to POST for consistency if PATCH fails on some setups
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title }),
            })

            if (!res.ok) throw new Error("Failed to rename set")

            toast.success("Attribute set renamed", {
                description: `Renamed to "${title}"`,
            })

            queryClient.invalidateQueries({ queryKey: ["attribute-sets"] })
            onOpenChange(false)
        } catch (err) {
            toast.error("Error", {
                description: (err as Error).message,
            })
        } finally {
            setLoading(false)
        }
    }

    return (
        <FocusModal open={open} onOpenChange={onOpenChange}>
            <FocusModal.Content>
                <FocusModal.Header>
                    <Button variant="primary" type="submit" form="rename-set-form" isLoading={loading}>
                        Save
                    </Button>
                </FocusModal.Header>
                <FocusModal.Body className="flex flex-col items-center py-16">
                    <div className="flex w-full max-w-lg flex-col gap-y-8">
                        <div className="flex flex-col gap-y-1">
                            <Heading>Rename Attribute Set</Heading>
                            <Text className="text-ui-fg-subtle">
                                Update the name of this attribute group.
                            </Text>
                        </div>
                        <form id="rename-set-form" onSubmit={handleSubmit} className="flex flex-col gap-y-4">
                            <div className="flex flex-col gap-y-2">
                                <Label htmlFor="rename-title">New Title</Label>
                                <Input
                                    id="rename-title"
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    required
                                    autoFocus
                                />
                            </div>
                        </form>
                    </div>
                </FocusModal.Body>
            </FocusModal.Content>
        </FocusModal>
    )
}
