import { Container, Heading, Text, Table, Button, Select, toast } from "@medusajs/ui"
import { useState, useEffect } from "react"

export const PendingRefundsCard = () => {
    const [refunds, setRefunds] = useState<any[]>([])
    const [bankAccounts, setBankAccounts] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [syncingId, setSyncingId] = useState<string | null>(null)
    const [selectedBankId, setSelectedBankId] = useState<Record<string, string>>({})

    const fetchData = async () => {
        setLoading(true)
        try {
            const [refRes, bankRes] = await Promise.all([
                fetch('/admin/finance/qb-refunds/pending', { credentials: 'include' }),
                fetch('/admin/finance/qb-bank-accounts', { credentials: 'include' })
            ])
            
            if (refRes.ok) {
                const rData = await refRes.json()
                setRefunds(rData.refunds || [])
            }
            if (bankRes.ok) {
                const bData = await bankRes.json()
                // Only active banks
                setBankAccounts((bData.qb_bank_accounts || []).filter((b: any) => b.is_active))
            }
        } catch (e) {
            toast.error("Failed to load queue data", { description: (e as Error).message })
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchData()
    }, [])

    const handleApprove = async (refundId: string) => {
        const bankId = selectedBankId[refundId]
        if (!bankId) { toast.error("Please select a bank account"); return }
        
        setSyncingId(refundId)
        try {
            const res = await fetch('/admin/finance/qb-refunds/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refund_id: refundId, qb_bank_account_id: bankId })
            })
            if (!res.ok) {
                const data = await res.json()
                throw new Error(data.error || "Sync failed")
            }
            toast.success("Refund synced successfully!")
            fetchData()
            
            // clear selection
            setSelectedBankId(prev => {
                const p = {...prev}
                delete p[refundId]
                return p
            })
        } catch (e) {
            toast.error("Failed to orchestrate sync", { description: (e as Error).message })
        } finally {
            setSyncingId(null)
        }
    }

    const formatAmount = (amt: number) => {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amt || 0)
    }

    return (
        <Container>
            <div className="p-4 border-b border-ui-border-base flex justify-between items-center">
                <div>
                    <Heading level="h2" className="text-large font-medium mb-1">Pending QB Refunds</Heading>
                    <Text className="text-ui-fg-subtle text-small">
                        Review and approve POS refunds to synchronize them with QuickBooks via Check + zero-dollar payment calculation.
                    </Text>
                </div>
                <Button variant="secondary" onClick={fetchData} isLoading={loading}>Refresh Queue</Button>
            </div>

            <Table>
                <Table.Header>
                    <Table.Row>
                        <Table.HeaderCell>Date</Table.HeaderCell>
                        <Table.HeaderCell>Amount</Table.HeaderCell>
                        <Table.HeaderCell>Original Payment</Table.HeaderCell>
                        <Table.HeaderCell>Status</Table.HeaderCell>
                        <Table.HeaderCell>Withdraw From</Table.HeaderCell>
                        <Table.HeaderCell></Table.HeaderCell>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {loading ? (
                        <Table.Row>
                            <Table.Cell className="text-center text-ui-fg-subtle p-4">Loading...</Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                        </Table.Row>
                    ) : refunds.length === 0 ? (
                        <Table.Row>
                            <Table.Cell className="text-center text-ui-fg-subtle p-4">No pending refunds found. All caught up!</Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                        </Table.Row>
                    ) : (
                        refunds.map(refund => (
                            <Table.Row key={refund.id}>
                                <Table.Cell className="text-xs text-ui-fg-subtle">
                                    {new Date(refund.created_at).toLocaleString()}
                                </Table.Cell>
                                <Table.Cell className="font-medium text-red-600">
                                    -{formatAmount(refund.amount)}
                                </Table.Cell>
                                <Table.Cell className="text-xs">
                                    {refund.payment?.id?.slice(0, 12)}...
                                </Table.Cell>
                                <Table.Cell>
                                    <span className="px-2 py-1 bg-orange-100 text-orange-800 rounded-full text-xs">
                                        Pending QB Sync
                                    </span>
                                </Table.Cell>
                                <Table.Cell>
                                    <Select 
                                        value={selectedBankId[refund.id] || ""} 
                                        onValueChange={(val) => setSelectedBankId(p => ({...p, [refund.id]: val}))}
                                    >
                                        <Select.Trigger className="w-[180px]">
                                            <Select.Value placeholder="Select Bank..." />
                                        </Select.Trigger>
                                        <Select.Content>
                                            {bankAccounts.map(b => (
                                                <Select.Item key={b.id} value={b.id}>{b.name}</Select.Item>
                                            ))}
                                        </Select.Content>
                                    </Select>
                                </Table.Cell>
                                <Table.Cell className="text-right">
                                    <Button 
                                        size="small" 
                                        className="bg-green-600 hover:bg-green-700 text-white"
                                        isLoading={syncingId === refund.id}
                                        onClick={() => handleApprove(refund.id)}
                                        disabled={!selectedBankId[refund.id] || syncingId !== null}
                                    >
                                        Approve & Sync
                                    </Button>
                                </Table.Cell>
                            </Table.Row>
                        ))
                    )}
                </Table.Body>
            </Table>
        </Container>
    )
}
