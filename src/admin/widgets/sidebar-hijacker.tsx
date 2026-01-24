import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useEffect } from "react"

/**
 * Install global hijacker immediately on script load (not waiting for React)
 */
if (typeof window !== 'undefined' && !(window as any).__hijackerInstalled) {
    const hijackClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement
        const link = target.closest('a[href="/app/products"]') as HTMLAnchorElement

        if (link) {
            // console.log("🎯 GLOBAL hijacker intercepted!")

            // Prevent default
            e.preventDefault()
            e.stopPropagation()

            // Use History API for SPA navigation
            window.history.pushState({}, '', '/app/products-advanced')
            window.dispatchEvent(new PopStateEvent('popstate'))
        }
    }

    // Listen with capture to intercept BEFORE React Router
    document.addEventListener("click", hijackClick as EventListener, true)
        ; (window as any).__hijackerInstalled = true
    // console.log("✅ INSTANT global hijacker active (SPA mode)")
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
    zone: "product.details.before",
})

export default GlobalHijacker
