import { PencilSquare } from "@medusajs/icons";
import {
  Container,
  Heading,
  Text,
  Button,
  Table,
  Badge,
  Prompt,
} from "@medusajs/ui";
import { useEffect, useState } from "react";

type SequencesData = {
  custom_estimate_seq: number | null;
  custom_order_seq: number | null;
  custom_medusa_invoice_seq: number | null;
  custom_credit_memo_seq: number | null;
  custom_invoice_seq: number | null;
  custom_sales_receipt_seq: number | null;
  custom_payment_seq: number | null;
};

const SEQUENCE_LABELS: Record<keyof SequencesData, string> = {
  custom_estimate_seq: "QB Estimates",
  custom_order_seq: "Sales Orders",
  custom_medusa_invoice_seq: "Medusa Invoices",
  custom_credit_memo_seq: "Returns (Credit Memos)",
  custom_invoice_seq: "QB Invoices & Credit Memos",
  custom_sales_receipt_seq: "QB Sales Receipts",
  custom_payment_seq: "Payments",
};

export function SequenceManagerCard() {
  const [sequences, setSequences] = useState<SequencesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingSeq, setEditingSeq] = useState<keyof SequencesData | null>(
    null
  );
  const [newValue, setNewValue] = useState<string>("");
  const [confirmText, setConfirmText] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState(false);

  const fetchSequences = async () => {
    try {
      const res = await fetch(`/admin/finance/sequences`, {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setSequences(data.sequences);
    } catch (e) {
      console.error("Failed to fetch sequences", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSequences();
  }, []);

  const handleSave = async () => {
    if (!editingSeq || !newValue) return;

    const numericValue = parseInt(newValue, 10);
    if (isNaN(numericValue) || numericValue < 1) {
      alert("Please enter a valid positive number.");
      return;
    }

    setIsUpdating(true);
    try {
      const res = await fetch(`/admin/finance/sequences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [editingSeq]: numericValue }),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to update sequence");
      setSequences((prev: SequencesData | null) =>
        prev ? { ...prev, [editingSeq]: numericValue } : null
      );
      setEditingSeq(null);
      setNewValue("");
      setConfirmText("");
    } catch (e: any) {
      alert(`Failed to update sequence: ${e.message}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const openEdit = (seq: keyof SequencesData, currentVal: number | null) => {
    setEditingSeq(seq);
    setNewValue(currentVal ? String(currentVal) : "1000");
    setConfirmText("");
  };

  return (
    <Container className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <Heading level="h2">Internal Sequence Cursors</Heading>
          <Text className="text-ui-fg-subtle text-sm">
            Manage the internal numbering sequences used to generate document
            IDs matching QuickBooks Desktop. Updates will take effect on the
            very next document created.
          </Text>
        </div>
        <Button
          variant="secondary"
          size="small"
          onClick={fetchSequences}
          isLoading={loading}
        >
          Refresh
        </Button>
      </div>

      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Document Type</Table.HeaderCell>
            <Table.HeaderCell>Sequence ID</Table.HeaderCell>
            <Table.HeaderCell>Last Value Used</Table.HeaderCell>
            <Table.HeaderCell className="w-[100px]"></Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {loading && !sequences ? (
            <Table.Row>
              <Table.Cell className="text-center text-ui-fg-subtle">
                Loading sequences...
              </Table.Cell>
              <Table.Cell></Table.Cell>
              <Table.Cell></Table.Cell>
              <Table.Cell></Table.Cell>
            </Table.Row>
          ) : sequences ? (
            (Object.keys(SEQUENCE_LABELS) as (keyof SequencesData)[]).map(
              (seqKey) => {
                const val = sequences[seqKey];
                return (
                  <Table.Row key={seqKey}>
                    <Table.Cell className="font-medium text-ui-fg-base">
                      {SEQUENCE_LABELS[seqKey as keyof SequencesData]}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="small">{seqKey}</Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-mono">
                        {val !== null ? val : "Not Initialized"}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <Button
                        variant="transparent"
                        size="small"
                        className="text-ui-fg-subtle hover:text-ui-fg-base"
                        onClick={() => openEdit(seqKey, val)}
                      >
                        <PencilSquare />
                        Edit
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                );
              }
            )
          ) : null}
        </Table.Body>
      </Table>

      <Prompt
        open={!!editingSeq}
        onOpenChange={(open) => !open && setEditingSeq(null)}
      >
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>Update Document Sequence</Prompt.Title>
            <Prompt.Description>
              Warning: Changing the internal sequence number will affect all new
              documents generated of this type. Ensure the new number does not
              collide with existing QuickBooks records.
            </Prompt.Description>
          </Prompt.Header>
          <div className="p-6 pt-0">
            <div className="flex flex-col gap-y-4">
              <div className="flex flex-col gap-y-1">
                <label className="text-ui-fg-base text-sm font-medium">
                  {editingSeq ? SEQUENCE_LABELS[editingSeq] : ""} Next Value
                </label>
                <input
                  type="number"
                  className="ui-input w-full"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder="e.g. 10452"
                />
                <span className="text-ui-fg-subtle text-xs mb-4">
                  Type the exact number the NEXT document should use.
                </span>

                <label className="text-ui-fg-base text-sm font-medium text-ui-fg-error">
                  Type CONFIRM to proceed
                </label>
                <input
                  type="text"
                  className="ui-input w-full"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="CONFIRM"
                />
              </div>
            </div>
          </div>
          <Prompt.Footer>
            <Prompt.Cancel
              onClick={() => {
                setEditingSeq(null);
                setConfirmText("");
              }}
            >
              Cancel
            </Prompt.Cancel>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={isUpdating || !newValue || confirmText !== "CONFIRM"}
              isLoading={isUpdating}
            >
              Confirm Update
            </Button>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>
    </Container>
  );
}
