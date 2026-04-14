import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Container,
  Heading,
  Button,
  Table,
  IconButton,
  usePrompt,
  toast,
  Input,
  Label,
  Badge,
  Textarea,
  Select,
  Text as TextUI,
} from "@medusajs/ui";
import {
  Trash,
  ArrowLeftMini,
  Plus,
  PencilSquare,
  Check,
} from "@medusajs/icons";
import { useState, useEffect } from "react";

const AttributeDetailPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const prompt = usePrompt();
  const queryClient = useQueryClient();

  // UI State
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [newValue, setNewValue] = useState("");

  // Display metadata state
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [filterType, setFilterType] = useState("checkbox");
  const [icon, setIcon] = useState("");
  const [unit, setUnit] = useState("");
  const [filterOrder, setFilterOrder] = useState("");

  // Local options state (not saved until "Save" is clicked)
  const [localOptions, setLocalOptions] = useState<string[]>([]);

  // FETCH
  const { data, isLoading } = useQuery({
    queryKey: ["attribute", id],
    queryFn: async () => {
      const res = await fetch(`/admin/attributes/${id}`);
      if (!res.ok) throw new Error("Failed to fetch attribute");
      return res.json();
    },
  });

  const attribute = data?.attribute;
  const productCount = data?.product_count || 0;

  // SYNC STATE
  useEffect(() => {
    if (attribute) {
      setEditTitle(attribute.label);
      setDisplayName(attribute.display_name || "");
      setDescription(attribute.description || "");
      setFilterType(attribute.filter_type || "checkbox");
      setIcon(attribute.icon || "");
      setUnit(attribute.unit || "");
      setFilterOrder(attribute.filter_order?.toString() || "");
      setLocalOptions(attribute.options || []);
    }
  }, [attribute]);

  // UPDATE MUTATION
  const updateAttribute = useMutation({
    mutationFn: async (payload: {
      label?: string;
      options?: string[];
      display_name?: string | null;
      description?: string | null;
      filter_type?: string | null;
      icon?: string | null;
      unit?: string | null;
      filter_order?: number | null;
    }) => {
      const res = await fetch(`/admin/attributes/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to update attribute");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["attribute", id] });
      queryClient.invalidateQueries({ queryKey: ["attributes"] });
      toast.success("Saved");
      setIsEditingTitle(false);
      setNewValue("");
    },
    onError: (err) => {
      toast.error("Error", { description: (err as Error).message });
    },
  });

  // DELETE MUTATION
  const deleteAttribute = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/admin/attributes/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      return res.json();
    },
    onSuccess: () => {
      toast.success("Deleted");
      queryClient.invalidateQueries({ queryKey: ["attributes"] });
      navigate("/attributes");
    },
  });

  // HANDLERS
  const handleSaveTitle = () => {
    if (!editTitle.trim()) return;
    updateAttribute.mutate({ label: editTitle });
  };

  // UNIFIED SAVE HANDLER - saves metadata + options
  const handleSave = () => {
    updateAttribute.mutate({
      label: attribute.label,
      options: localOptions,
      display_name: displayName || null,
      description: description || null,
      filter_type: filterType || null,
      icon: icon || null,
      unit: unit || null,
      filter_order: filterOrder ? parseInt(filterOrder) : null,
    });
  };

  // RENAME VALUE HANDLER (local only)
  const handleRenameValue = (oldVal: string, newVal: string) => {
    if (!newVal.trim() || oldVal === newVal) return;

    // Check duplicate
    if (localOptions.includes(newVal.trim())) {
      toast.error("Value already exists");
      return;
    }

    const updated = localOptions.map((o) => (o === oldVal ? newVal.trim() : o));
    setLocalOptions(updated);
  };

  // ADD VALUE HANDLER (local only)
  const handleAddValue = () => {
    if (!newValue.trim()) return;

    if (localOptions.includes(newValue.trim())) {
      toast.error("Value already exists");
      return;
    }

    setLocalOptions([...localOptions, newValue.trim()]);
    setNewValue(""); // Clear input after adding
  };

  const handleDeleteValue = async (valToDelete: string) => {
    const confirmed = await prompt({
      title: "Delete Value?",
      description: `Remove "${valToDelete}"? Changes will be saved when you click Save.`,
      confirmText: "Remove",
      variant: "danger",
    });

    if (!confirmed) return;

    setLocalOptions(localOptions.filter((o) => o !== valToDelete));
  };

  const handleDeleteAttribute = async () => {
    const confirmed = await prompt({
      title: "Delete Attribute?",
      description:
        productCount > 0
          ? `This attribute is currently used by ${productCount} product${productCount === 1 ? "" : "s"}. Deleting it will remove this attribute from all products. This action is irreversible.`
          : "This will permanently delete this attribute. This action is irreversible.",
      confirmText: "Delete",
      variant: "danger",
    });
    if (confirmed) deleteAttribute.mutate();
  };

  if (isLoading || !attribute) return <Container>Loading...</Container>;

  return (
    <div className="flex flex-col gap-4 max-w-4xl mx-auto pb-10">
      {/* NAV & HEADER */}
      <div className="flex items-center justify-between">
        <Button
          variant="transparent"
          onClick={() => navigate("/attributes")}
          className="gap-2 text-ui-fg-subtle"
        >
          <ArrowLeftMini /> Back to Attributes
        </Button>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-ui-bg-subtle px-2 py-1 rounded text-xs text-ui-fg-muted font-mono select-all">
            <span className="font-semibold">ID:</span> {attribute.id}
          </div>
          <IconButton
            variant="transparent"
            className="text-ui-fg-error"
            onClick={handleDeleteAttribute}
          >
            <Trash />
          </IconButton>
        </div>
      </div>

      {/* MAIN CARD */}
      <Container>
        <div className="flex flex-col gap-6">
          {/* TITLE EDIT */}
          <div className="flex flex-col gap-2">
            <Label className="text-ui-fg-subtle">Attribute Name</Label>
            {isEditingTitle ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  autoFocus
                />
                <IconButton variant="primary" onClick={handleSaveTitle}>
                  <Check />
                </IconButton>
                <Button
                  variant="transparent"
                  onClick={() => setIsEditingTitle(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 group">
                <Heading level="h1">{attribute.label}</Heading>
                <IconButton
                  variant="transparent"
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => setIsEditingTitle(true)}
                >
                  <PencilSquare />
                </IconButton>
              </div>
            )}
            <div className="flex items-center gap-2 mt-1">
              <Badge>{attribute.handle}</Badge>
              {attribute.attribute_set_id ? (
                <Badge color="blue">Assigned to Set</Badge>
              ) : (
                <Badge color="orange">Unassigned</Badge>
              )}
            </div>
          </div>

          <div className="w-full h-px bg-ui-border-base" />

          {/* DISPLAY CONFIGURATION SECTION */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <Heading level="h2">Display Configuration</Heading>
              <Button variant="secondary" size="small" onClick={handleSave}>
                Save
              </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="display_name">Display Name</Label>
                <Input
                  id="display_name"
                  placeholder="e.g. Color Temperature"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
                <TextUI size="small" className="text-ui-fg-muted">
                  Override for frontend. If empty, uses Attribute Name.
                </TextUI>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="filter_type">Filter Type</Label>
                <Select value={filterType} onValueChange={setFilterType}>
                  <Select.Trigger id="filter_type">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="checkbox">Checkbox</Select.Item>
                    <Select.Item value="range">Range</Select.Item>
                    <Select.Item value="toggle">Toggle</Select.Item>
                    <Select.Item value="dropdown">Dropdown</Select.Item>
                    <Select.Item value="color-swatch">Color Swatch</Select.Item>
                  </Select.Content>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="e.g. Select the white color temperature for your LED strip"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="icon">Icon</Label>
                <Input
                  id="icon"
                  placeholder="thermometer"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                />
                <TextUI size="small" className="text-ui-fg-muted">
                  e.g. thermometer, bolt, ruler
                </TextUI>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="unit">Unit</Label>
                <Input
                  id="unit"
                  placeholder="K"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                />
                <TextUI size="small" className="text-ui-fg-muted">
                  e.g. K, V, W, mm
                </TextUI>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="filter_order">Display Order</Label>
                <Input
                  id="filter_order"
                  type="number"
                  placeholder="1"
                  value={filterOrder}
                  onChange={(e) => setFilterOrder(e.target.value)}
                  min="0"
                />
              </div>
            </div>
          </div>

          <div className="w-full h-px bg-ui-border-base" />

          {/* VALUES MANAGEMENT */}
          <div className="flex flex-col gap-6">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
              <Heading level="h2">Attribute Values</Heading>
              <div className="flex items-center gap-2 w-full md:w-auto">
                <Input
                  placeholder="Add value (e.g. Red)"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  className="w-full md:w-64"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddValue();
                  }}
                />
                <Button
                  variant="secondary"
                  onClick={handleAddValue}
                  disabled={!newValue.trim()}
                >
                  <Plus /> Add
                </Button>
              </div>
            </div>

            <div className="border border-ui-border-base rounded-lg overflow-hidden">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Value</Table.HeaderCell>
                    <Table.HeaderCell className="w-24 text-right">
                      Actions
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {localOptions && localOptions.length > 0 ? (
                    localOptions.map((val: string, idx: number) => (
                      <ValueRow
                        key={idx}
                        value={val}
                        onRename={handleRenameValue}
                        onDelete={handleDeleteValue}
                      />
                    ))
                  ) : (
                    <Table.Row>
                      <Table.Cell className="text-center py-8 text-ui-fg-muted italic">
                        No values defined for this attribute. Add one above.
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table>
            </div>
          </div>
        </div>
      </Container>
    </div>
  );
};

// Sub-component for editable row
const ValueRow = ({
  value,
  onRename,
  onDelete,
}: {
  value: string;
  onRename: (o: string, n: string) => void;
  onDelete: (v: string) => void;
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editVal, setEditVal] = useState(value);

  const save = () => {
    onRename(value, editVal);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <Table.Row>
        <Table.Cell>
          <div className="flex items-center gap-2">
            <Input
              value={editVal}
              onChange={(e) => setEditVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setIsEditing(false);
              }}
              autoFocus
              size="small"
            />
          </div>
        </Table.Cell>
        <Table.Cell className="text-right">
          <div className="flex items-center justify-end gap-1">
            <IconButton variant="transparent" size="small" onClick={save}>
              <Check />
            </IconButton>
            <IconButton
              variant="transparent"
              size="small"
              onClick={() => setIsEditing(false)}
            >
              <Plus className="rotate-45" /> {/* Close icon */}
            </IconButton>
          </div>
        </Table.Cell>
      </Table.Row>
    );
  }

  return (
    <Table.Row className="group">
      <Table.Cell>{value}</Table.Cell>
      <Table.Cell className="text-right">
        <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <IconButton
            variant="transparent"
            size="small"
            onClick={() => setIsEditing(true)}
          >
            <PencilSquare className="text-ui-fg-subtle" />
          </IconButton>
          <IconButton
            variant="transparent"
            size="small"
            className="text-ui-fg-error"
            onClick={() => onDelete(value)}
          >
            <Trash />
          </IconButton>
        </div>
      </Table.Cell>
    </Table.Row>
  );
};

export default AttributeDetailPage;
