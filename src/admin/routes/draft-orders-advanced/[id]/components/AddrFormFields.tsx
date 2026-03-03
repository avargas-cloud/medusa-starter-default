import { Input, Label } from "@medusajs/ui"
import type { AddrForm } from "../types"

interface AddrFormFieldsProps {
    form: AddrForm
    onChange: (k: keyof AddrForm, v: string) => void
}

export const AddrFormFields = ({ form, onChange }: AddrFormFieldsProps) => (
    <div className="space-y-3">
        {(["first_name", "last_name"] as const).map((k) => (
            <div key={k}>
                <Label className="mb-1 block text-sm">{k === "first_name" ? "First Name" : "Last Name"}</Label>
                <Input value={form[k]} onChange={e => onChange(k, e.target.value)} />
            </div>
        ))}
        <div><Label className="mb-1 block text-sm">Company (optional)</Label><Input value={form.company ?? ""} onChange={e => onChange("company", e.target.value)} /></div>
        <div><Label className="mb-1 block text-sm">Address 1</Label><Input value={form.address_1} onChange={e => onChange("address_1", e.target.value)} /></div>
        <div><Label className="mb-1 block text-sm">Address 2 (optional)</Label><Input value={form.address_2} onChange={e => onChange("address_2", e.target.value)} /></div>
        {(["city", "province", "postal_code", "country_code"] as const).map((k) => (
            <div key={k}>
                <Label className="mb-1 block text-sm">
                    {k === "city" ? "City" : k === "province" ? "State / Province" : k === "postal_code" ? "Postal Code" : "Country Code (e.g. US)"}
                </Label>
                <Input value={form[k]} onChange={e => onChange(k, e.target.value)} />
            </div>
        ))}
        <div><Label className="mb-1 block text-sm">Phone (optional)</Label><Input value={form.phone ?? ""} onChange={e => onChange("phone", e.target.value)} /></div>
    </div>
)
