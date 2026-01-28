import { useEffect } from "react";

/**
 * Hook to intercept clicks on the native "Customers" sidebar link
 * and redirect them to the Advanced Customer Page using SPA navigation.
 */
export const useGlobalHijacker = () => {
    useEffect(() => {
        const hijackCustomersClick = (e: Event) => {
            const target = e.target as HTMLElement;
            const link = target.closest('a[href="/app/customers"]') as HTMLAnchorElement;

            if (link) {
                // Prevent default navigation
                e.preventDefault();
                e.stopPropagation();

                console.log("🕵️ Hijack Triggered: Redirecting to /app/customers-advanced");
                // Use History API for SPA navigation (no reload)
                window.history.pushState({}, '', '/app/customers-advanced');

                // Trigger React Router navigation event
                window.dispatchEvent(new PopStateEvent('popstate'));
            }
        };

        // Listen with capture to intercept BEFORE React Router
        document.addEventListener("click", hijackCustomersClick as EventListener, true);

        return () => {
            document.removeEventListener("click", hijackCustomersClick as EventListener, true);
        };
    }, []);
};
