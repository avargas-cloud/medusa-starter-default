import { Button, Heading, Input, Label, Text, toast, FocusModal } from "@medusajs/ui"
import { useState, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"

type CreateAttributeModalProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
}

export const CreateAttributeModal = ({ open, onOpenChange }: CreateAttributeModalProps) => {
    const [label, setLabel] = useState("")
    const [handle, setHandle] = useState("")
    const [loading, setLoading] = useState(false)
    const queryClient = useQueryClient()

    // Auto-generate handle from label
    useEffect(() => {
        if (!label) {
            setHandle("")
            return
        }
        // Simple slugify: lowercase, replace spaces with dashes, remove special chars
        const slug = label
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^\w-]/g, "")
        setHandle(slug)
    }, [label])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)

        try {
            const res = await fetch("/admin/attributes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ label, handle }), // options default to empty
            })

            if (!res.ok) {
                const errData = await res.json()
                throw new Error(errData.message || "Failed to create attribute")
            }

            const data = await res.json()
            toast.success("Attribute created", {
                description: `Created "${data.attribute.label}"`,
            })

            queryClient.invalidateQueries({ queryKey: ["attributes"] })
            queryClient.invalidateQueries({ queryKey: ["attribute-sets"] }) // might affect counts
            onOpenChange(false)
            setLabel("")
            setHandle("")
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
                    <Button variant="primary" type="submit" form="create-attr-form" isLoading={loading}>
                        Create Attribute
                    </Button>
                </FocusModal.Header>
                <FocusModal.Body className="flex flex-col items-center py-16">
                    <div className="flex w-full max-w-lg flex-col gap-y-8">
                        <div className="flex flex-col gap-y-1">
                            <Heading>Create Attribute</Heading>
                            <Text className="text-ui-fg-subtle">
                                Define a new product attribute (e.g. Material, Voltage).
                            </Text>
                        </div>
                        <form id="create-attr-form" onSubmit={handleSubmit} className="flex flex-col gap-y-4">
                            <div className="flex flex-col gap-y-2">
                                <Label htmlFor="label">Attribute Name</Label>
                                <Input
                                    id="label"
                                    placeholder="e.g. Material"
                                    value={label}
                                    onChange={(e) => setLabel(e.target.value)}
                                    autoFocus
                                    required
                                />
                            </div>
                            <div className="flex flex-col gap-y-2">
                                <Label htmlFor="handle">Handle (ID)</Label>
                                <Input
                                    id="handle"
                                    value={handle}
                                    onChange={(e) => setHandle(e.target.value)}
                                    required
                                    className="font-mono text-ui-fg-subtle"
                                />
                                <Text size="small" className="text-ui-fg-muted">
                                    Unique identifier used in code/API.
                                </Text>
                            </div>
                        </form>
                    </div>
                </FocusModal.Body>
            </FocusModal.Content>
        </FocusModal>
    )
}
