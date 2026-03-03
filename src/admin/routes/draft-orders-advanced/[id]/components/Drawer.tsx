import { Heading, Button } from "@medusajs/ui"
import { XMark } from "@medusajs/icons"
import React from "react"

interface DrawerProps {
    open: boolean
    onClose: () => void
    title: string
    subtitle?: string
    onSave?: () => void
    saving?: boolean
    saveLabel?: string
    width?: string
    noPadding?: boolean
    children: React.ReactNode
}

export const Drawer = ({ open, onClose, title, subtitle, onSave, saving, saveLabel = "Save", width = "420px", noPadding = false, children }: DrawerProps) => {
    if (!open) return null
    return (
        <div className="fixed inset-0 z-50 flex">
            <div className="flex-1 bg-black/40" onClick={onClose} />
            <div style={{ width }} className="bg-ui-bg-base border-l border-ui-border-base flex flex-col shadow-xl">
                <div className="flex items-start justify-between px-6 py-4 border-b border-ui-border-base">
                    <div>
                        <Heading level="h2">{title}</Heading>
                        {subtitle && <p className="text-ui-fg-subtle text-xs mt-0.5">{subtitle}</p>}
                    </div>
                    <button onClick={onClose} className="text-ui-fg-muted hover:text-ui-fg-base mt-0.5"><XMark /></button>
                </div>
                <div className={`flex-1 overflow-auto${noPadding ? "" : " px-6 py-5"}`}>{children}</div>
                {onSave && (
                    <div className="flex justify-end gap-2 px-6 py-4 border-t border-ui-border-base">
                        <Button variant="secondary" size="small" onClick={onClose}>Cancel</Button>
                        <Button size="small" onClick={onSave} isLoading={saving} disabled={saving}>{saveLabel}</Button>
                    </div>
                )}
            </div>
        </div>
    )
}
