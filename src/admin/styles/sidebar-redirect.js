/**
 * Sidebar Redirect + Hide Duplicate
 * 
 * Strategy: 
 * 1. Redirect native "Products" button to advanced search
 * 2. Hide the duplicate "Advanced Products" in Extensions
 */

document.addEventListener('DOMContentLoaded', function () {
    setupProductsRedirect();
});

// Also run on any route change (SPA navigation)
const originalPushState = history.pushState;
history.pushState = function () {
    originalPushState.apply(history, arguments);
    setTimeout(setupProductsRedirect, 100);
};

function setupProductsRedirect() {
    const allProductsLinks = document.querySelectorAll('aside a[href="/app/products"], aside a[href="/app/products-advance"]');

    let nativeFound = false;

    allProductsLinks.forEach(link => {
        // First one is the native Products (well positioned)
        if (!nativeFound && link.href.includes('/app/products')) {
            link.href = '/app/products-advance';
            nativeFound = true;
            console.log('✅ Redirected native Products button');
        }
        // Any additional ones (in Extensions) should be hidden
        else if (link.href.includes('/app/products-advance')) {
            link.style.display = 'none';
            const parentLi = link.closest('li');
            if (parentLi) parentLi.style.display = 'none';
            console.log('✅ Hid duplicate Products in Extensions');
        }
    });
}
