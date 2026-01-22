import { useState } from "react"
import { useQueryClient, useMutation } from "@tanstack/react-query"
import {
    Button,
    Input,
    Prompt,
    Select,
    toast,
} from "@medusajs/ui"

interface MoveAttributeModalProps {
    attributeId: string
    attributeLabel: string
    currentSetId?: string | null
    sets: Array<{ id: string; title: string }>
    onClose: () => void
}

export function MoveAttributeModal({
    attributeId,
    attributeLabel,
    currentSetId,
    sets,
    onClose,
}: MoveAttributeModalProps) {
    const queryClient = useQueryClient()
    const [selectedSetId, setSelectedSetId] = useState<string>(currentSetId || "")
    const [isCreatingNew, setIsCreatingNew] = useState(false)
    const [newSetTitle, setNewSetTitle] = useState("")

    // Mutation to create a new set
    const createSetMutation = useMutation({
        mutationFn: async (title: string) => {
            const res = await fetch("/admin/attribute-sets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ title }),
            })
            if (!res.ok) throw new Error("Failed to create set")
            return res.json()
        },
    })

    // Mutation to move attribute
    const moveMutation = useMutation({
        mutationFn: async (setId: string | null) => {
            const res = await fetch(`/admin/attributes/${attributeId}/move`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ attribute_set_id: setId }),
            })
            if (!res.ok) throw new Error("Failed to move attribute")
            return res.json()
        },
        onSuccess: () => {
            toast.success("Attribute moved", {
                description: `"${attributeLabel}" has been moved successfully`,
            })
            queryClient.invalidateQueries({ queryKey: ["attributes"] })
            queryClient.invalidateQueries({ queryKey: ["attribute-sets"] })
            onClose()
        },
        onError: () => {
            toast.error("Error", {
                description: "Could not move the attribute",
            })
        },
    })

    const handleMove = async () => {
        if (isCreatingNew) {
            // Create new set first, then move
            if (!newSetTitle.trim()) {
                toast.error("Error", { description: "Please enter a set name" })
                return
            }

            try {
                const { attribute_set } = await createSetMutation.mutateAsync(newSetTitle)
                await moveMutation.mutateAsync(attribute_set.id)
            } catch (error) {
                toast.error("Error", {
                    description: "Failed to create set or move attribute",
                })
            }
        } else {
            // Move to existing set
            moveMutation.mutate(selectedSetId || null)
        }
    }

    return (
        <Prompt open onOpenChange={onClose}>
            <Prompt.Content>
                <Prompt.Header>
                    <Prompt.Title>Move Attribute</Prompt.Title>
                    <Prompt.Description>
                        Move "{attributeLabel}" to a different attribute set
                    </Prompt.Description>
                </Prompt.Header>

                <div className="flex flex-col gap-4 py-4">
                    {!isCreatingNew ? (
                        <>
                            <Select
                                value={selectedSetId}
                                onValueChange={(value) => {
                                    if (value === "__CREATE_NEW__") {
                                        setIsCreatingNew(true)
                                    } else {
                                        setSelectedSetId(value)
                                    }
                                }}
                            >
                                <Select.Trigger>
                                    <Select.Value placeholder="Select a set..." />
                                </Select.Trigger>
                                <Select.Content>
                                    <Select.Item value="">
                                        Unassigned (No Set)
                                    </Select.Item>
                                    {sets.map((set) => (
                                        <Select.Item key={set.id} value={set.id}>
                                            {set.title}
                                        </Select.Item>
                                    ))}
                                    <Select.Separator />
                                    <Select.Item value="__CREATE_NEW__">
                                        + Create New Set
                                    </Select.Item>
                                </Select.Content>
                            </Select>
                        </>
                    ) : (
                        <>
                            <div>
                                <label className="text-sm font-medium mb-2 block">
                                    New Set Name
                                </label>
                                <Input
                                    autoFocus
                                    placeholder="e.g., Electrical Specifications"
                                    value={newSetTitle}
                                    onChange={(e) => setNewSetTitle(e.target.value)}
                                />
                            </div>
                            <Button
                                variant="secondary"
                                size="small"
                                onClick={() => {
                                    setIsCreatingNew(false)
                                    setNewSetTitle("")
                                }}
                            >
                                ← Back to selection
                            </Button>
                        </>
                    )}
                </div>

                <Prompt.Footer>
                    <Prompt.Cancel>Cancel</Prompt.Cancel>
                    <Prompt.Action onClick={handleMove}>
                        {isCreatingNew ? "Create & Move" : "Move"}
                    </Prompt.Action>
                </Prompt.Footer>
            </Prompt.Content>
        </Prompt>
    )
}
