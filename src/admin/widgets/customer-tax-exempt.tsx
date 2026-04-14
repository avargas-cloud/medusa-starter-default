import { useState, useEffect, useRef } from "react";
import { Container, Select, Input, Text, Badge, toast } from "@medusajs/ui";
import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { DetailWidgetProps } from "@medusajs/framework/types";
import { HttpTypes } from "@medusajs/types";

// ── Widget config ──────────────────────────────────────────────────────────────
export const config = defineWidgetConfig({
  zone: "customer.details.after",
});

// ── Widget ────────────────────────────────────────────────────────────────────
const CustomerTaxExemptWidget = ({
  data,
}: DetailWidgetProps<HttpTypes.AdminCustomer>) => {
  const m: any = (data as any)?.metadata ?? {};

  const [isExempt, setIsExempt] = useState<string>(m.is_tax_exempt ?? "No");
  const [taxId, setTaxId] = useState<string>(m.tax_id ?? "");
  const [docUrl, setDocUrl] = useState<string>(m.tax_exempt_doc_url ?? "");
  const [docName, setDocName] = useState<string>(m.tax_exempt_doc_name ?? "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const meta: any = (data as any)?.metadata ?? {};
    setIsExempt(meta.is_tax_exempt ?? "No");
    setTaxId(meta.tax_id ?? "");
    setDocUrl(meta.tax_exempt_doc_url ?? "");
    setDocName(meta.tax_exempt_doc_name ?? "");
  }, [data?.id]);

  // ── Persist any metadata change ────────────────────────────────────────────
  const persist = async (patch: Record<string, string>) => {
    setSaving(true);
    try {
      const r = await fetch(`/admin/customers/${data.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: patch }),
      });
      if (!r.ok) throw new Error();
      toast.success("Tax Exempt info saved");
    } catch {
      toast.error("Failed to save Tax Exempt info");
    } finally {
      setSaving(false);
    }
  };

  const updateExempt = (val: string) => {
    setIsExempt(val);
    persist({
      is_tax_exempt: val,
      tax_id: taxId,
      tax_exempt_doc_url: docUrl,
      tax_exempt_doc_name: docName,
    });
  };

  const updateTaxId = () => {
    persist({
      is_tax_exempt: isExempt,
      tax_id: taxId,
      tax_exempt_doc_url: docUrl,
      tax_exempt_doc_name: docName,
    });
  };

  // ── File upload ────────────────────────────────────────────────────────────
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate type + size (max 10MB)
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
    ];
    if (!allowed.includes(file.type)) {
      toast.error("Only PDF, JPEG, PNG or WEBP files are supported");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File must be under 10 MB");
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append("files", file);
      const r = await fetch("/admin/uploads", {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!r.ok) throw new Error((await r.json())?.message ?? "Upload failed");
      const json = await r.json();
      // Medusa v2 /admin/uploads returns { files: [{ url, key, ... }] }
      const url: string = json.files?.[0]?.url ?? json.uploads?.[0]?.url ?? "";
      if (!url) throw new Error("No URL in upload response");
      setDocUrl(url);
      setDocName(file.name);
      await persist({
        is_tax_exempt: isExempt,
        tax_id: taxId,
        tax_exempt_doc_url: url,
        tax_exempt_doc_name: file.name,
      });
    } catch (err: any) {
      toast.error(err?.message ?? "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeDoc = async () => {
    setDocUrl("");
    setDocName("");
    await persist({
      is_tax_exempt: isExempt,
      tax_id: taxId,
      tax_exempt_doc_url: "",
      tax_exempt_doc_name: "",
    });
  };

  const labelClass =
    "text-[10px] font-bold text-ui-fg-muted uppercase tracking-wider mb-1 block";

  return (
    <Container>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">Tax Exempt</span>
          {isExempt === "Yes" && (
            <Badge color="green" size="small">
              Exempt
            </Badge>
          )}
          {isExempt === "No" && (
            <Badge color="grey" size="small">
              Taxable
            </Badge>
          )}
        </div>
        {(saving || uploading) && (
          <Text size="xsmall" className="text-ui-fg-muted">
            {uploading ? "Uploading…" : "Saving…"}
          </Text>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Is Tax Exempt */}
        <div>
          <label className={labelClass}>Tax Exempt Status</label>
          <Select value={isExempt} onValueChange={updateExempt}>
            <Select.Trigger className="h-8 text-sm w-full">
              <Select.Value placeholder="Select…" />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="Yes">Yes — Tax Exempt</Select.Item>
              <Select.Item value="No">No — Taxable</Select.Item>
            </Select.Content>
          </Select>
        </div>

        {/* Tax ID */}
        <div>
          <label className={labelClass}>Tax ID / Exemption #</label>
          <Input
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            onBlur={updateTaxId}
            placeholder="e.g. 85-1234567"
            className="h-8 text-sm"
          />
        </div>
      </div>

      {/* Certificate upload ─────────────────────────────────────────────── */}
      <div className="mt-4">
        <label className={labelClass}>Exemption Certificate</label>

        {docUrl ? (
          /* Existing document */
          <div className="flex items-center gap-3 p-2 bg-ui-bg-subtle rounded border border-ui-border-base">
            {/* Icon */}
            <div className="text-ui-fg-muted text-lg shrink-0">📄</div>
            <div className="flex-1 min-w-0">
              <Text size="xsmall" className="font-medium truncate">
                {docName || "Certificate"}
              </Text>
              <a
                href={docUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-ui-fg-interactive hover:underline"
              >
                View / Download
              </a>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => fileRef.current?.click()}
                className="text-[11px] text-ui-fg-muted hover:text-ui-fg-base px-2 py-1 rounded border border-ui-border-base"
              >
                Replace
              </button>
              <button
                onClick={removeDoc}
                className="text-[11px] text-red-500 hover:text-red-700 px-2 py-1 rounded border border-red-200"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          /* Upload prompt */
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="w-full flex flex-col items-center justify-center gap-1 p-4 border border-dashed border-ui-border-strong rounded text-ui-fg-muted hover:border-ui-fg-interactive hover:text-ui-fg-interactive transition-colors disabled:opacity-50"
          >
            <span className="text-2xl">☁️</span>
            <Text size="xsmall">
              {uploading
                ? "Uploading…"
                : "Click to upload exemption certificate"}
            </Text>
            <Text size="xsmall" className="text-ui-fg-subtle">
              PDF, JPEG or PNG — max 10 MB
            </Text>
          </button>
        )}

        {/* Hidden file input */}
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.webp"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      <Text size="xsmall" className="text-ui-fg-muted mt-3">
        Tax exempt status and certificate are stored in customer metadata.
      </Text>
    </Container>
  );
};

export default CustomerTaxExemptWidget;
