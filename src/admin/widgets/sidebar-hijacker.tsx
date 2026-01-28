import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useEffect } from "react"

/**
 * Install global hijacker immediately on script load (not waiting for React)
 * Hijacks Products, Inventory, and Customers sidebar buttons
 */
if (typeof window !== 'undefined' && !(window as any).__hijackerInstalled) {
    const hijackClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement

        // Hijack Products
        const productsLink = target.closest('a[href="/app/products"]') as HTMLAnchorElement
        if (productsLink) {
            e.preventDefault()
            e.stopPropagation()
            window.history.pushState({}, '', '/app/products-advanced')
            window.dispatchEvent(new PopStateEvent('popstate'))
            return
        }

        // Hijack Inventory
        const inventoryLink = target.closest('a[href="/app/inventory"]') as HTMLAnchorElement
        if (inventoryLink) {
            e.preventDefault()
            e.stopPropagation()
            window.history.pushState({}, '', '/app/inventory-advanced')
            window.dispatchEvent(new PopStateEvent('popstate'))
            return
        }

        // Hijack Customers
        const customersLink = target.closest('a[href="/app/customers"]') as HTMLAnchorElement
        if (customersLink) {
            e.preventDefault()
            e.stopPropagation()
            window.history.pushState({}, '', '/app/customers-advanced')
            window.dispatchEvent(new PopStateEvent('popstate'))
            return
        }
    }

    // Listen with capture to intercept BEFORE React Router
    document.addEventListener("click", hijackClick as EventListener, true)
        ; (window as any).__hijackerInstalled = true
}

/**
 * Widget component (invisible, just ensures script loads)
 */
const GlobalHijacker = () => {
    useEffect(() => {
        // console.log("GlobalHijacker widget mounted")
    }, [])

    return null
}

export const config = defineWidgetConfig({
    zone: "order.details.before",
})

export default GlobalHijacker
