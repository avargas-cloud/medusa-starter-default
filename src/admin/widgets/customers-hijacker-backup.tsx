import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useEffect } from "react"

/**
 * BACKUP WIDGET: Ensures hijacker loads specifically on customer-related pages
 * This is a fallback in case sidebar-hijacker.tsx doesn't load early enough
 */
if (typeof window !== 'undefined' && !(window as any).__customersHijackerInstalled) {
    const hijackClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement

        // Hijack Customers
        const customersLink = target.closest('a[href="/app/customers"]') as HTMLAnchorElement
        if (customersLink) {
            e.preventDefault()
            e.stopPropagation()
            console.log("✅ [CUSTOMERS-HIJACKER] Redirecting to /app/customers-advanced")
            window.history.pushState({}, '', '/app/customers-advanced')
            window.dispatchEvent(new PopStateEvent('popstate'))
            return
        }
    }

    // Listen with capture to intercept BEFORE React Router
    document.addEventListener("click", hijackClick as EventListener, true)
        ; (window as any).__customersHijackerInstalled = true
    console.log("✅ [CUSTOMERS-HIJACKER] Backup hijacker installed")
}

const CustomersHijacker = () => {
    useEffect(() => {
        console.log("✅ [CUSTOMERS-HIJACKER] Widget mounted")
    }, [])

    return null
}

export const config = defineWidgetConfig({
    zone: "customer.list.before",
})

export default CustomersHijacker
