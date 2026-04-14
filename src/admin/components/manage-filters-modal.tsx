import {
  Button,
  FocusModal,
  Heading,
  Badge,
  Text,
  Checkbox,
} from "@medusajs/ui";
import { useState, useEffect } from "react";
import { XMark } from "@medusajs/icons";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

type Attribute = {
  id: string;
  label: string;
  handle: string;
  filter_type: string;
};

type ManageFiltersModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categoryId: string;
  categoryName: string;
  activeFilterIds: string[];
  availableAttributes: Attribute[];
  overrideInheritance: boolean;
  onSave: (activeIds: string[], override: boolean) => Promise<void>;
};

const SortableFilterItem = ({
  attribute,
  isNew,
}: {
  attribute: Attribute;
  isNew?: boolean;
}) => {
  const {
    attributes: dndAttributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: attribute.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...dndAttributes}
      {...listeners}
      className={`flex items-center gap-3 p-3 rounded border cursor-move hover:bg-ui-bg-base-hover ${
        isNew
          ? "bg-ui-bg-warning-subtle border-ui-border-warning"
          : "bg-ui-bg-base border-ui-border-base"
      }`}
    >
      <div className="flex-1">
        <Text size="small" weight="plus">
          {attribute.label}{" "}
          <span className="text-ui-fg-muted font-normal">
            ({attribute.handle})
          </span>
        </Text>
      </div>
      <Badge size="small" color={isNew ? "orange" : "blue"}>
        {attribute.filter_type || "checkbox"}
      </Badge>
      {isNew && (
        <Badge size="small" color="orange" className="ml-auto">
          New
        </Badge>
      )}
    </div>
  );
};

export const ManageFiltersModal = ({
  open,
  onOpenChange,
  categoryName,
  activeFilterIds,
  availableAttributes,
  overrideInheritance: initialOverride,
  onSave,
}: ManageFiltersModalProps) => {
  const [activeIds, setActiveIds] = useState<string[]>(activeFilterIds);
  const [overrideInheritance, setOverrideInheritance] =
    useState(initialOverride);
  const [isSaving, setIsSaving] = useState(false);
  const [newlyAddedIds, setNewlyAddedIds] = useState<Set<string>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Initialize active list and clear newly-added tracking
  useEffect(() => {
    if (open) {
      setActiveIds(activeFilterIds);
      setOverrideInheritance(initialOverride);
      setNewlyAddedIds(new Set()); // Reset on open
    }
  }, [open, activeFilterIds, initialOverride]);

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = activeIds.indexOf(active.id);
    const newIndex = activeIds.indexOf(over.id);
    setActiveIds(arrayMove(activeIds, oldIndex, newIndex));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(activeIds, overrideInheritance);
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to save filters:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const toggleFilter = (id: string) => {
    if (activeIds.includes(id)) {
      // Removing from active
      setActiveIds(activeIds.filter((i) => i !== id));
      setNewlyAddedIds((prev) => {
        const updated = new Set(prev);
        updated.delete(id);
        return updated;
      });
    } else {
      // Adding to active - mark as newly added
      setActiveIds([...activeIds, id]);
      setNewlyAddedIds((prev) => new Set(prev).add(id));
    }
  };

  const activeAttrs = availableAttributes
    .filter((attr) => activeIds.includes(attr.id))
    .sort((a, b) => activeIds.indexOf(a.id) - activeIds.indexOf(b.id));

  const inactiveAttrs = availableAttributes
    .filter((attr) => !activeIds.includes(attr.id))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <FocusModal open={open} onOpenChange={onOpenChange}>
      <FocusModal.Content className="max-h-[90vh] flex flex-col">
        <FocusModal.Header className="flex-shrink-0">
          <div className="flex items-center justify-between w-full">
            <div>
              <Heading>Edit Category Filters</Heading>
              <Text className="text-ui-fg-subtle">{categoryName}</Text>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="small"
                variant="secondary"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                size="small"
                variant="primary"
                onClick={handleSave}
                isLoading={isSaving}
              >
                Save Changes
              </Button>
            </div>
          </div>
        </FocusModal.Header>

        <FocusModal.Body className="flex-1 overflow-hidden">
          <div className="flex flex-col gap-4 h-full">
            {/* Override Toggle */}
            <div className="flex items-center gap-3 p-4 bg-ui-bg-subtle rounded flex-shrink-0">
              <Checkbox
                checked={overrideInheritance}
                onCheckedChange={(checked) => setOverrideInheritance(!!checked)}
              />
              <div className="flex-1">
                <Text size="small" weight="plus">
                  Override parent category filters
                </Text>
                <Text className="text-ui-fg-muted text-xs">
                  If unchecked, this category inherits filters from its parent
                </Text>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
              {/* Active Filters - Drag and Drop */}
              <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 mb-2 flex-shrink-0">
                  <Heading level="h3" className="text-sm">
                    Active Filters
                  </Heading>
                  <Badge size="small" color="green">
                    {activeIds.length}
                  </Badge>
                </div>
                <Text className="text-ui-fg-muted text-xs mb-3 flex-shrink-0">
                  Drag to reorder • Order affects storefront display
                </Text>
                <div className="border rounded p-3 max-h-[calc(90vh-300px)] overflow-y-auto bg-ui-bg-base">
                  {activeAttrs.length === 0 ? (
                    <Text className="text-ui-fg-muted text-sm text-center py-8">
                      Select filters from available list →
                    </Text>
                  ) : (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleDragEnd}
                    >
                      <SortableContext
                        items={activeIds}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="space-y-2">
                          {activeAttrs.map((attr) => (
                            <div
                              key={attr.id}
                              className="flex items-center gap-2"
                            >
                              <div className="flex-1">
                                <SortableFilterItem
                                  attribute={attr}
                                  isNew={newlyAddedIds.has(attr.id)}
                                />
                              </div>
                              <Button
                                size="small"
                                variant="transparent"
                                onClick={() => toggleFilter(attr.id)}
                              >
                                <XMark />
                              </Button>
                            </div>
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  )}
                </div>
              </div>

              {/* Available Filters - Click Plus to Add */}
              <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 mb-2 flex-shrink-0">
                  <Heading level="h3" className="text-sm">
                    Available Filters
                  </Heading>
                  <Badge size="small" color="grey">
                    {inactiveAttrs.length}
                  </Badge>
                </div>
                <Text className="text-ui-fg-muted text-xs mb-3 flex-shrink-0">
                  Alphabetical order • Click + to activate
                </Text>
                <div className="border rounded p-3 max-h-[calc(90vh-300px)] overflow-y-auto bg-ui-bg-subtle">
                  {inactiveAttrs.length === 0 ? (
                    <Text className="text-ui-fg-muted text-sm text-center py-8">
                      All available filters are active
                    </Text>
                  ) : (
                    <div className="space-y-0 divide-y divide-ui-border-base">
                      {inactiveAttrs.map((attr) => (
                        <div
                          key={attr.id}
                          className="flex items-center gap-3 p-3 hover:bg-ui-bg-base-hover"
                        >
                          <div className="flex-1">
                            <Text size="small">{attr.label}</Text>
                            <Text className="text-ui-fg-muted text-xs">
                              {attr.handle}
                            </Text>
                          </div>
                          <Badge size="small" color="grey">
                            {attr.filter_type || "checkbox"}
                          </Badge>
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => toggleFilter(attr.id)}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <line x1="12" y1="5" x2="12" y2="19"></line>
                              <line x1="5" y1="12" x2="19" y2="12"></line>
                            </svg>
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  );
};
