import { useState, useEffect, useRef } from "react";
import { Text, Input, Label, toast } from "@medusajs/ui";
import { ArrowUpTray } from "@medusajs/icons";

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: (sentTo: string) => void;
  orderId: string;
  displayId: string | number;
  customerEmail?: string;
  total: number;
  curr: string;
}

export const SendEstimateModal = ({
  open,
  onClose,
  onSuccess,
  orderId,
  displayId,
  customerEmail,
  total,
  curr,
}: Props) => {
  const [to, setTo] = useState(customerEmail ?? "");
  const [subject, setSubject] = useState("");
  const [sending, setSending] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const fmtTotal = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: curr.toUpperCase(),
  }).format(total);

  useEffect(() => {
    if (!open) return;
    setTo(customerEmail ?? "");
    setSubject(`Estimate #${displayId} from EcoPowerTech`);
    loadPreview();
  }, [open, orderId]);

  const loadPreview = async () => {
    setPreviewLoading(true);
    try {
      const r = await fetch(`/admin/draft-orders/${orderId}/send-estimate`, {
        credentials: "include",
      });
      if (r.ok) {
        const html = await r.text();
        // Inject same CSS as @media print: hide flex spacer (.grow) and collapse body height
        // so the preview matches the generated PDF exactly (no dead space between Notes and Store Policies)
        const adjusted = html.replace(
          "</head>",
          `<style>.grow{display:none!important}body{display:block!important;min-height:unset!important;padding:12mm 14mm}</style></head>`
        );
        setPreviewHtml(adjusted);
      }
    } catch {
    } finally {
      setPreviewLoading(false);
    }
  };

  // Inject HTML into iframe when previewHtml changes
  useEffect(() => {
    if (!previewHtml || !iframeRef.current) return;
    const doc = iframeRef.current.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(previewHtml);
    doc.close();
  }, [previewHtml]);

  const handleSend = async () => {
    if (!to) return;
    setSending(true);
    try {
      const r = await fetch(`/admin/draft-orders/${orderId}/send-estimate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject }),
      });
      const j = await r.json();
      if (j.preview_only) {
        toast.warning(
          "SMTP not set up yet — configure SENDGRID_API_KEY in .env to enable sending."
        );
      } else if (j.success) {
        toast.success(`Estimate sent to ${j.sent_to}`);
        onSuccess?.(j.sent_to ?? to);
        onClose();
      } else {
        toast.error(j.message ?? "Failed to send");
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)" }}
    >
      <div
        className="bg-ui-bg-base rounded-xl shadow-2xl flex flex-col"
        style={{ width: "80vw", maxWidth: "1100px", height: "85vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base shrink-0">
          <div>
            <Text weight="plus" size="large">
              Send Estimate #{displayId}
            </Text>
            <Text size="xsmall" className="text-ui-fg-muted mt-0.5">
              Preview and send to customer
            </Text>
          </div>
          <button
            onClick={onClose}
            className="text-ui-fg-muted hover:text-ui-fg-base text-xl font-bold w-8 h-8 flex items-center justify-center rounded-full hover:bg-ui-bg-subtle transition-colors"
          >
            ×
          </button>
        </div>

        {/* Body — left config, right preview */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel — config */}
          <div className="w-72 shrink-0 flex flex-col border-r border-ui-border-base p-5 gap-4">
            <div>
              <Label className="mb-1 block text-xs">To</Label>
              <Input
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="customer@email.com"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs">Subject</Label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div className="mt-auto space-y-2">
              <Text size="xsmall" className="text-ui-fg-muted">
                Total:{" "}
                <span className="font-semibold text-ui-fg-base">
                  {fmtTotal}
                </span>
              </Text>
              <button
                onClick={handleSend}
                disabled={sending || !to}
                className="w-full flex items-center justify-center gap-2 bg-ui-bg-interactive text-ui-fg-on-color font-semibold text-sm py-2.5 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <ArrowUpTray className="w-4 h-4" />
                {sending ? "Sending…" : "Send Estimate"}
              </button>
              <button
                onClick={onClose}
                className="w-full text-sm text-ui-fg-muted hover:text-ui-fg-base py-2"
              >
                Cancel
              </button>
            </div>
          </div>

          {/* Right panel — email preview */}
          <div className="flex-1 overflow-hidden bg-ui-bg-subtle relative">
            {previewLoading && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Text size="small" className="text-ui-fg-muted">
                  Loading preview…
                </Text>
              </div>
            )}
            <iframe
              ref={iframeRef}
              title="Estimate Preview"
              className="w-full h-full border-0"
              sandbox="allow-same-origin allow-scripts"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
