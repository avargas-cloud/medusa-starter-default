import { Container, Heading, Badge, Text, Button, DropdownMenu } from "@medusajs/ui"
import { EllipsisHorizontal, PencilSquare, ArrowRight, ArrowUpRightOnBox, ArrowUpTray, XCircle, Trash } from "@medusajs/icons"
import { fmtDate } from "../helpers"

interface Props {
    id: string
    displayId: number
    regionName?: string
    createdAt: string
    scName: string
    converting: boolean
    onNavigateBack: () => void
    onConvert: () => void
    onOpenModal: (modal: string) => void
    onCancel: () => void
    onDelete: () => void
    onSendEstimate?: () => void
    onPrintEstimate?: () => void
}

export const OrderHeader = ({
    id, displayId, regionName, createdAt, scName,
    converting, onNavigateBack, onConvert, onOpenModal, onCancel, onDelete, onSendEstimate, onPrintEstimate,
}: Props) => (
    <Container className="p-0 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4">
            <div>
                <button onClick={onNavigateBack} className="text-ui-fg-muted text-xs mb-1 hover:text-ui-fg-base">← Draft Orders</button>
                <div className="flex items-center gap-2">
                    <Heading level="h1">Draft Order #{displayId}</Heading>
                    {regionName && <Badge color="grey" size="small">{regionName}</Badge>}
                </div>
                <Text size="small" className="text-ui-fg-subtle">
                    {fmtDate(createdAt)} · <span className="text-ui-fg-muted">{scName}</span>
                </Text>
            </div>
            <div className="flex items-center gap-2">
                {onPrintEstimate && (
                    <Button variant="secondary" size="small" onClick={onPrintEstimate}>
                        🖨️ Print in Store
                    </Button>
                )}
                {onSendEstimate && (
                    <Button variant="secondary" size="small" onClick={onSendEstimate}>
                        <ArrowUpTray /> Send Estimate
                    </Button>
                )}
                <Button variant="primary" size="small" onClick={onConvert} isLoading={converting} disabled={converting}>
                    <ArrowRight /> Convert to Order
                </Button>
                <DropdownMenu>
                    <DropdownMenu.Trigger asChild>
                        <Button variant="secondary" size="small"><EllipsisHorizontal /></Button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content>
                        <DropdownMenu.Item className="gap-x-2" onClick={() => onOpenModal("sales-channel")}>
                            <PencilSquare className="text-ui-fg-subtle" /> Edit sales channel
                        </DropdownMenu.Item>
                        <DropdownMenu.Item className="gap-x-2" onClick={() => onOpenModal("metadata")}>
                            <PencilSquare className="text-ui-fg-subtle" /> Edit metadata
                        </DropdownMenu.Item>
                        <DropdownMenu.Item className="gap-x-2" onClick={() => window.open(`/app/draft-orders/${id}`, "_blank")}>
                            <ArrowUpRightOnBox className="text-ui-fg-subtle" /> Open native editor
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item className="gap-x-2 text-ui-fg-error" onClick={onCancel}>
                            <XCircle className="text-ui-fg-error" /> Cancel draft order
                        </DropdownMenu.Item>
                        <DropdownMenu.Item className="gap-x-2 text-ui-fg-error" onClick={onDelete}>
                            <Trash className="text-ui-fg-error" /> Delete draft order
                        </DropdownMenu.Item>
                    </DropdownMenu.Content>
                </DropdownMenu>
            </div>
        </div>
    </Container>
)
