import { defineWidgetConfig } from "@medusajs/admin-sdk"

/**
 * ⚠️ DISABLED BY TUTOR RECOMMENDATION ⚠️
 * The previous implementation caused critical React State update errors:
 * "Warning: Cannot update a component (`ForwardRef`) while rendering a different component"
 *
 * Strategy change: Verification > UI Hacks.
 * We will coexist with the native customer list for now.
 */

// // IIFE to install the global hijacker immediately
// if (typeof window !== 'undefined' && !(window as any).__customerHijackerInstalled) {
//     const hijackCustomerClick = (e: MouseEvent) => {
//        // ... logic disabled ...
//     }
//     // document.addEventListener("click", hijackCustomerClick as EventListener, true)
//     // (window as any).__customerHijackerInstalled = true
// }

const CustomerSidebarHijacker = () => {
    return null
}

export const config = defineWidgetConfig({
    zone: ["customer.list.before", "order.list.before"],
})

export default CustomerSidebarHijacker
