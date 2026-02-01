import { defineRouteConfig } from "@medusajs/admin-sdk"
import { CircleDollarSign } from "@medusajs/icons"

export const QuickBooksPage = () => {
    return (
        <div className="flex flex-col gap-4 p-8">
            <div>
                <h1 className="text-xl font-semibold">QuickBooks Integration</h1>
                <p className="text-ui-fg-subtle">Manage synchronization between Medusa and QuickBooks</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Inventory Sync Card */}
                <div className="bg-ui-bg-base shadow rounded-lg p-6 border border-ui-border-base">
                    <h2 className="text-lg font-medium mb-4">📦 Inventory Sync</h2>
                    <p className="text-sm text-ui-fg-subtle mb-4">
                        Sync stock levels from QuickBooks
                    </p>
                    <div className="flex items-center gap-2 mb-4">
                        <label className="text-sm font-medium">Interval (minutes):</label>
                        <input
                            type="number"
                            className="w-24 px-3 py-2 border rounded"
                            defaultValue={30}
                            min={5}
                            max={10080}
                        />
                    </div>
                    <button className="bg-ui-bg-interactive px-4 py-2 rounded text-white font-medium hover:bg-ui-bg-interactive-hover">
                        Sync Now
                    </button>
                    <p className="text-xs text-ui-fg-muted mt-2">Last sync: Never</p>
                </div>

                {/* Price Sync Card */}
                <div className="bg-ui-bg-base shadow rounded-lg p-6 border border-ui-border-base">
                    <h2 className="text-lg font-medium mb-4">💵 Price Sync</h2>
                    <p className="text-sm text-ui-fg-subtle mb-4">
                        Sync product prices from QuickBooks
                    </p>
                    <div className="flex items-center gap-2 mb-4">
                        <label className="text-sm font-medium">Interval (minutes):</label>
                        <input
                            type="number"
                            className="w-24 px-3 py-2 border rounded"
                            defaultValue={1440}
                            min={5}
                            max={10080}
                        />
                    </div>
                    <button className="bg-ui-bg-interactive px-4 py-2 rounded text-white font-medium hover:bg-ui-bg-interactive-hover">
                        Sync Now
                    </button>
                    <p className="text-xs text-ui-fg-muted mt-2">Last sync: Never</p>
                </div>

                {/* Customer Audit Card */}
                <div className="bg-ui-bg-base shadow rounded-lg p-6 border border-ui-border-base">
                    <h2 className="text-lg font-medium mb-4">👥 Customer Audit</h2>
                    <p className="text-sm text-ui-fg-subtle mb-4">
                        Compare customers between QuickBooks and Medusa
                    </p>
                    <button className="bg-ui-bg-base border border-ui-border-base px-4 py-2 rounded font-medium hover:bg-ui-bg-base-hover">
                        Check Now
                    </button>
                </div>

                {/* Bridge Status Card */}
                <div className="bg-ui-bg-base shadow rounded-lg p-6 border border-ui-border-base">
                    <h2 className="text-lg font-medium mb-4">🌉 Bridge Status</h2>
                    <p className="text-sm text-ui-fg-subtle mb-4">
                        QuickBooks Bridge API connection
                    </p>
                    <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-ui-tag-green-icon"></div>
                        <span className="text-sm">Connected</span>
                    </div>
                    <p className="text-xs text-ui-fg-muted mt-2">
                        https://ecopower-qb.loca.lt
                    </p>
                </div>
            </div>

            {/* Sync Logs */}
            <div className="bg-ui-bg-base shadow rounded-lg border border-ui-border-base">
                <div className="p-6 border-b border-ui-border-base">
                    <h2 className="text-lg font-medium">📋 Sync Logs</h2>
                    <p className="text-sm text-ui-fg-subtle">Recent synchronization history</p>
                </div>
                <div className="p-6">
                    <p className="text-center text-ui-fg-muted py-8">
                        No sync operations yet. Click "Sync Now" to start.
                    </p>
                </div>
            </div>
        </div>
    )
}

export const config = defineRouteConfig({
    label: "QuickBooks",
    icon: CircleDollarSign,
})

export default QuickBooksPage
