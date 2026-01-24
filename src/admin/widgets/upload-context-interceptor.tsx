import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useEffect } from "react"

const UploadContextInterceptor = () => {
    useEffect(() => {
        // 1. FETCH INTERCEPTOR (Modern)
        const originalFetch = window.fetch
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = input.toString()
            if (url.includes("/admin/uploads")) {
                const context = getContextFromPath()
                if (context) {
                    const newInit = { ...init }
                    newInit.headers = {
                        ...newInit.headers,
                        "x-upload-context": context,
                    }
                    return originalFetch(input, newInit)
                }
            }
            return originalFetch(input, init)
        }

        // 2. XHR INTERCEPTOR (Classic - Used for uploads with progress bars)
        const originalOpen = XMLHttpRequest.prototype.open
        const originalSend = XMLHttpRequest.prototype.send

        XMLHttpRequest.prototype.open = function (method, url) {
            // Save URL to check it in send method
            // @ts-ignore
            this._urlTarget = url
            // @ts-ignore
            return originalOpen.apply(this, arguments)
        }

        XMLHttpRequest.prototype.send = function () {
            // @ts-ignore
            if (this._urlTarget && typeof this._urlTarget === "string" && this._urlTarget.includes("/admin/uploads")) {
                const context = getContextFromPath()
                if (context) {
                    console.log(`[XHR Interceptor] Inyectando contexto: ${context}`)
                    this.setRequestHeader("x-upload-context", context)
                }
            }
            // @ts-ignore
            return originalSend.apply(this, arguments)
        }

        // Helper to determine context from current path
        const getContextFromPath = () => {
            const path = window.location.pathname
            if (path.includes("/products")) return "products"
            if (path.includes("/categories")) return "categories"
            return null
        }

        // Cleanup
        return () => {
            window.fetch = originalFetch
            XMLHttpRequest.prototype.open = originalOpen
            XMLHttpRequest.prototype.send = originalSend
        }
    }, [])
    
    return null // Invisible widget
}

// Inject in multiple zones to ensure script runs in all upload scenarios
export const config = defineWidgetConfig({
    zone: [
        "product.details.before",
        "product.list.before",
        "category.details.before",
        "category.list.before",
    ],
})

export default UploadContextInterceptor
