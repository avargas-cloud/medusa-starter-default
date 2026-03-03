import { Navigate } from "react-router-dom"

/**
 * Redirect: /draft-orders → /draft-orders-advanced
 *
 * This page intercepts the native "Drafts" sidebar link and redirects to
 * our custom Draft Orders Advanced page, which includes QB sync functionality.
 *
 * Note: This overrides the @medusajs/draft-order module's list page.
 * Use the "Edit ↗" link in /draft-orders-advanced to access the native editor.
 */
const DraftOrdersRedirect = () => {
    return <Navigate to="/draft-orders-advanced" replace />
}

export default DraftOrdersRedirect
