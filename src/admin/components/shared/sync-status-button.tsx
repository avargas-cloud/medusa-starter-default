import { useState } from "react"
import { Button, clx } from "@medusajs/ui"
import { ArrowPath, CheckCircle, ExclamationCircle } from "@medusajs/icons"

type SyncStatus = "idle" | "loading" | "already_synced" | "synced_now" | "error"

interface SyncStatusButtonProps {
    entity: "products" | "customers"
    label?: string
    onSyncComplete?: () => void
}

export const SyncStatusButton = ({ entity, label = "Check Sync", onSyncComplete }: SyncStatusButtonProps) => {
    const [status, setStatus] = useState<SyncStatus>("idle")
    const [message, setMessage] = useState<string>("")

    const handleSync = async () => {
        setStatus("loading")
        setMessage("Checking...")

        try {
            // "products" endpoint handles both Product & Inventory pages
            const endpoint = entity === "products"
                ? "/admin/search/products/sync"
                : "/admin/search/customers/sync"

            const response = await fetch(endpoint, {
                method: "POST",
                credentials: "include"
            })
            const data = await response.json()

            if (data.status === "already_synced") {
                setStatus("already_synced")
                setMessage("Synced Already")
            } else {
                setStatus("synced_now")
                setMessage("Synced Now")
                // Success! Trigger refresh
                onSyncComplete?.()
            }

            // Keep success state visible

        } catch (error) {
            console.error(error)
            setStatus("error")
            setMessage("Sync Failed")
        }
    }

    return (
        <div className="flex items-center gap-2">
            <Button
                variant="secondary"
                size="small"
                onClick={handleSync}
                disabled={status === "loading"}
                className={clx(
                    "transition-all duration-200 gap-2",
                    status === "already_synced" && "bg-transparent text-ui-fg-interactive hover:bg-ui-bg-base-hover border-transparent shadow-none",
                    status === "synced_now" && "bg-transparent text-blue-600 hover:bg-ui-bg-base-hover border-transparent shadow-none",
                    status === "error" && "bg-red-50 text-red-600"
                )}
            >
                {status === "loading" && <ArrowPath className="animate-spin" />}
                {status === "idle" && <ArrowPath />}
                {status === "already_synced" && <CheckCircle className="text-green-500" />}
                {status === "synced_now" && <CheckCircle className="text-blue-500" />}
                {status === "error" && <ExclamationCircle />}

                <span>
                    {status === "idle" ? label : message}
                </span>
            </Button>

            {/* Optional: Last checked timestamp could go here */}
        </div>
    )
}
