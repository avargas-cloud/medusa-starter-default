import { useEffect } from "react";

/**
 * Hook to intercept clicks on the native "Products" sidebar link
 * and redirect them to the Advanced Product Page using SPA navigation.
 */
export const useGlobalHijacker = () => {
    useEffect(() => {
        const hijackProductsClick = (e: Event) => {
            const target = e.target as HTMLElement;
            const link = target.closest('a[href="/app/products"]') as HTMLAnchorElement;

            if (link) {
                // Prevent default navigation
                e.preventDefault();
                e.stopPropagation();

                // Use History API for SPA navigation (no reload)
                window.history.pushState({}, '', '/app/products-advanced');

                // Trigger React Router navigation event
                window.dispatchEvent(new PopStateEvent('popstate'));
            }
        };

        // Listen with capture to intercept BEFORE React Router
        document.addEventListener("click", hijackProductsClick as EventListener, true);

        return () => {
            document.removeEventListener("click", hijackProductsClick as EventListener, true);
        };
    }, []);
};
