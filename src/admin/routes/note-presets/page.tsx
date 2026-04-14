import { defineRouteConfig } from "@medusajs/admin-sdk";
import { DocumentText } from "@medusajs/icons";
import {
  Container,
  Heading,
  Button,
  Input,
  Label,
  Text,
  toast,
  Badge,
} from "@medusajs/ui";
import { useState, useEffect, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────
interface NotePreset {
  id: string;
  group_name: string;
  title: string;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// ── Group colour map ───────────────────────────────────────────────────────────
const GROUP_COLORS: Record<
  string,
  "blue" | "green" | "orange" | "purple" | "grey"
> = {
  "Store Policy": "blue",
  "Scope of Work": "green",
  Installation: "orange",
  Projects: "purple",
};

// ── Default groups (used for "Add" selector) ───────────────────────────────────
const KNOWN_GROUPS = [
  "Store Policy",
  "Scope of Work",
  "Installation",
  "Projects",
];

// ── Modal ──────────────────────────────────────────────────────────────────────
function PresetModal({
  preset,
  onClose,
  onSave,
}: {
  preset: Partial<NotePreset> | null;
  onClose: () => void;
  onSave: (data: Partial<NotePreset>) => Promise<void>;
}) {
  const [group, setGroup] = useState<string>(
    preset?.group_name ?? KNOWN_GROUPS[0]!
  );
  const [customGroup, setCustomGroup] = useState("");
  const [title, setTitle] = useState(preset?.title ?? "");
  const [content, setContent] = useState(preset?.content ?? "");
  const [saving, setSaving] = useState(false);

  const isCustom = !KNOWN_GROUPS.includes(group);

  const handleSave = async () => {
    const g = customGroup.trim() || group;
    if (!g || !title.trim() || !content.trim()) {
      toast.error("All fields are required");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        group_name: g,
        title: title.trim(),
        content: content.trim(),
      });
      onClose();
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-ui-bg-base border border-ui-border-base rounded-xl shadow-2xl w-[600px] max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-ui-border-base flex items-center justify-between">
          <Heading level="h2">
            {preset?.id ? "Edit Preset" : "New Preset"}
          </Heading>
          <button
            onClick={onClose}
            className="text-ui-fg-muted hover:text-ui-fg-base text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {/* Group */}
          <div>
            <Label className="mb-1 block text-sm">Group</Label>
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-field text-ui-fg-base"
            >
              {KNOWN_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              <option value="__custom__">Custom group…</option>
            </select>
            {(group === "__custom__" || isCustom) && (
              <Input
                className="mt-2"
                placeholder="Custom group name"
                value={customGroup}
                onChange={(e) => setCustomGroup(e.target.value)}
              />
            )}
          </div>
          {/* Title */}
          <div>
            <Label className="mb-1 block text-sm">Title</Label>
            <Input
              placeholder="e.g. No Service"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          {/* Content */}
          <div>
            <Label className="mb-1 block text-sm">Content</Label>
            <textarea
              rows={10}
              className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-field text-ui-fg-base resize-vertical font-mono"
              placeholder="Note text that will be appended to the estimate…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-ui-border-base flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={saving}>
            Save Preset
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
const NotePresetsPage = () => {
  const [presets, setPresets] = useState<NotePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<Partial<NotePreset> | null | false>(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/admin/note-presets", { credentials: "include" });
      const { presets: data } = await r.json();
      setPresets(data ?? []);
    } catch {
      toast.error("Failed to load presets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = useCallback(
    async (data: Partial<NotePreset>) => {
      if (modal && (modal as NotePreset).id) {
        const r = await fetch(
          `/admin/note-presets/${(modal as NotePreset).id}`,
          {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          }
        );
        if (!r.ok) throw new Error();
        toast.success("Preset updated");
      } else {
        const r = await fetch("/admin/note-presets", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!r.ok) throw new Error();
        toast.success("Preset created");
      }
      await load();
    },
    [modal, load]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await fetch(`/admin/note-presets/${id}`, {
          method: "DELETE",
          credentials: "include",
        });
        toast.success("Deleted");
        setDeleteConfirm(null);
        await load();
      } catch {
        toast.error("Failed to delete");
      }
    },
    [load]
  );

  // Group presets
  const grouped: Record<string, NotePreset[]> = {};
  for (const p of presets) {
    if (!grouped[p.group_name]) grouped[p.group_name] = [];
    grouped[p.group_name]!.push(p);
  }
  const groupOrder = [
    ...KNOWN_GROUPS,
    ...Object.keys(grouped).filter((g) => !KNOWN_GROUPS.includes(g)),
  ];

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Heading level="h1">Note Presets</Heading>
          <Text className="text-ui-fg-muted mt-1">
            Manage Quick Notes presets used in the POS estimate editor.
          </Text>
        </div>
        <Button onClick={() => setModal({})}>+ Add Preset</Button>
      </div>

      {loading ? (
        <Text className="text-ui-fg-muted">Loading…</Text>
      ) : (
        groupOrder
          .filter((g) => grouped[g]?.length)
          .map((groupName) => (
            <Container key={groupName} className="p-0 overflow-hidden">
              {/* Group header */}
              <div className="flex items-center gap-2 px-4 py-2.5 bg-ui-bg-subtle border-b border-ui-border-base">
                <Badge color={GROUP_COLORS[groupName] ?? "grey"}>
                  {groupName}
                </Badge>
                <Text className="text-ui-fg-muted text-xs ml-auto">
                  {grouped[groupName]!.length} preset
                  {grouped[groupName]!.length !== 1 ? "s" : ""}
                </Text>
              </div>
              {/* Presets list */}
              <div className="divide-y divide-ui-border-base">
                {grouped[groupName]!.map((p) => (
                  <div key={p.id} className="px-4 py-3 flex gap-4">
                    <div className="flex-1 min-w-0">
                      <Text className="font-semibold text-sm text-ui-fg-base">
                        {p.title}
                      </Text>
                      <Text className="text-xs text-ui-fg-muted mt-0.5 whitespace-pre-wrap line-clamp-2">
                        {p.content}
                      </Text>
                    </div>
                    <div className="flex items-start gap-2 flex-shrink-0">
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => setModal(p)}
                      >
                        Edit
                      </Button>
                      {deleteConfirm === p.id ? (
                        <>
                          <Button
                            variant="danger"
                            size="small"
                            onClick={() => handleDelete(p.id)}
                          >
                            Confirm
                          </Button>
                          <Button
                            variant="secondary"
                            size="small"
                            onClick={() => setDeleteConfirm(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="danger"
                          size="small"
                          onClick={() => setDeleteConfirm(p.id)}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Container>
          ))
      )}

      {/* Modal */}
      {modal !== false && (
        <PresetModal
          preset={modal}
          onClose={() => setModal(false)}
          onSave={handleSave}
        />
      )}
    </div>
  );
};

export const config = defineRouteConfig({
  label: "Note Presets",
  icon: DocumentText,
});

export default NotePresetsPage;
