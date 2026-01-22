import { Button, Heading, Input, Label, Text, toast, FocusModal } from "@medusajs/ui"
import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

type CreateSetModalProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
}

export const CreateSetModal = ({ open, onOpenChange }: CreateSetModalProps) => {
    const [title, setTitle] = useState("")
    const [loading, setLoading] = useState(false)
    const queryClient = useQueryClient()

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)

        try {
            const res = await fetch("/admin/attribute-sets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title }),
            })

            if (!res.ok) throw new Error("Failed to create set")

            const data = await res.json()
            toast.success("Attribute set created", {
                description: `Created "${data.attribute_set.title}"`,
            })

            queryClient.invalidateQueries({ queryKey: ["attribute-sets"] })
            onOpenChange(false)
            setTitle("")
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
                    <Button variant="primary" type="submit" form="create-set-form" isLoading={loading}>
                        Create
                    </Button>
                </FocusModal.Header>
                <FocusModal.Body className="flex flex-col items-center py-16">
                    <div className="flex w-full max-w-lg flex-col gap-y-8">
                        <div className="flex flex-col gap-y-1">
                            <Heading>Create Attribute Set</Heading>
                            <Text className="text-ui-fg-subtle">
                                Group your attributes into sets for better organization.
                            </Text>
                        </div>
                        <form id="create-set-form" onSubmit={handleSubmit} className="flex flex-col gap-y-4">
                            <div className="flex flex-col gap-y-2">
                                <Label htmlFor="title">Set Title</Label>
                                <Input
                                    id="title"
                                    placeholder="e.g. Electrical Specifications"
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    autoFocus
                                    required
                                />
                            </div>
                        </form>
                    </div>
                </FocusModal.Body>
            </FocusModal.Content>
        </FocusModal>
    )
}
