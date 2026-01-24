/**
 * Global Products Button Hijacker
 * 
 * This script runs immediately when loaded and hijacks ALL clicks
 * on the native Products button, redirecting to advanced search
 */

(function () {
    const hijackProductsClick = (e) => {
        const target = e.target;
        const link = target.closest('a[href="/app/products"]');

        if (link) {
            console.log("🎯 Intercepted Products click!");
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            // Navigate to advanced search
            window.location.href = "/app/products-advanced";
        }
    };

    // Listen with capture to intercept BEFORE React Router
    document.addEventListener("click", hijackProductsClick, true);
    console.log("✅ Global Products hijacker loaded");
})();
