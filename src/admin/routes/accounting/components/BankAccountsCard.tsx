import { Container, Heading, Text, Table, Button, Input, toast } from "@medusajs/ui"
import { useState, useEffect } from "react"

export const BankAccountsCard = () => {
    const [accounts, setAccounts] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [creating, setCreating] = useState(false)
    const [newName, setNewName] = useState("")
    const [newListId, setNewListId] = useState("")

    const fetchAccounts = async () => {
        setLoading(true)
        try {
            const res = await fetch('/admin/finance/qb-bank-accounts', { credentials: 'include' })
            if (!res.ok) throw new Error("Failed to fetch")
            const data = await res.json()
            setAccounts(data.qb_bank_accounts)
        } catch (e) {
            toast.error("Failed to load bank accounts", { description: (e as Error).message })
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchAccounts()
    }, [])

    const handleCreate = async () => {
        if (!newName || !newListId) { toast.error("Missing fields"); return }
        setCreating(true)
        try {
            const res = await fetch('/admin/finance/qb-bank-accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName, list_id: newListId, type: 'Bank' })
            })
            if (!res.ok) {
                const data = await res.json()
                throw new Error(data.error || "Failed to create")
            }
            toast.success("Bank account mapped")
            setNewName("")
            setNewListId("")
            fetchAccounts()
        } catch (e) {
            toast.error("Error creating mapping", { description: (e as Error).message })
        } finally {
            setCreating(false)
        }
    }

    return (
        <Container>
            <div className="p-4 border-b border-ui-border-base flex justify-between items-center">
                <div>
                    <Heading level="h2" className="text-large font-medium mb-1">QuickBooks Bank Accounts</Heading>
                    <Text className="text-ui-fg-subtle text-small">
                        Map POS payment methods to real QuickBooks Bank Accounts using their ListID.
                    </Text>
                </div>
            </div>
            
            <div className="p-4 flex gap-2 items-end bg-ui-bg-subtle border-b border-ui-border-base">
                <div className="flex-1">
                    <Text className="text-small font-medium mb-1">Account Name (e.g. Cash Register)</Text>
                    <Input placeholder="Cash Register" value={newName} onChange={e => setNewName(e.target.value)} />
                </div>
                <div className="flex-1">
                    <Text className="text-small font-medium mb-1">QuickBooks ListID</Text>
                    <Input placeholder="80000000-XXXXXXXXX" value={newListId} onChange={e => setNewListId(e.target.value)} />
                </div>
                <Button variant="secondary" onClick={handleCreate} isLoading={creating}>
                    Add Mapping
                </Button>
            </div>

            <Table>
                <Table.Header>
                    <Table.Row>
                        <Table.HeaderCell>Name</Table.HeaderCell>
                        <Table.HeaderCell>ListID</Table.HeaderCell>
                        <Table.HeaderCell>Type</Table.HeaderCell>
                        <Table.HeaderCell>Status</Table.HeaderCell>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {loading ? (
                        <Table.Row>
                            <Table.Cell className="text-center text-ui-fg-subtle p-4">Loading...</Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                        </Table.Row>
                    ) : accounts.length === 0 ? (
                        <Table.Row>
                            <Table.Cell className="text-center text-ui-fg-subtle p-4">No bank accounts mapped yet.</Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                            <Table.Cell></Table.Cell>
                        </Table.Row>
                    ) : (
                        accounts.map(acc => (
                            <Table.Row key={acc.id}>
                                <Table.Cell className="font-medium">{acc.name}</Table.Cell>
                                <Table.Cell className="font-mono text-xs">{acc.list_id}</Table.Cell>
                                <Table.Cell>{acc.type}</Table.Cell>
                                <Table.Cell>
                                    <span className={`px-2 py-1 rounded-full text-xs ${acc.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                        {acc.is_active ? 'Active' : 'Inactive'}
                                    </span>
                                </Table.Cell>
                            </Table.Row>
                        ))
                    )}
                </Table.Body>
            </Table>
        </Container>
    )
}
