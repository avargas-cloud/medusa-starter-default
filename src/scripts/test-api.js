const fetch = require('node-fetch');

async function test() {
    try {
        // 1. Get a category ID
        const res = await fetch('http://localhost:9000/admin/product-categories?limit=3');
        const data = await res.json();

        if (!data.product_categories || data.product_categories.length === 0) {
            console.log("No categories found");
            return;
        }

        const parent = data.product_categories.find(c => c.category_children && c.category_children.length > 0) || data.product_categories[0];
        console.log("Testing with Parent ID:", parent.id);

        // 2. Test Filters Method
        const urlFilters = `http://localhost:9000/admin/product-categories?filters[parent_category_id]=${parent.id}`;
        const resFilters = await fetch(urlFilters);
        const dataFilters = await resFilters.json();
        console.log(`Query: filters[parent_category_id] -> Count: ${dataFilters.product_categories?.length || 0}`);

        // 3. Test Direct Parameter Method
        const urlParams = `http://localhost:9000/admin/product-categories?parent_category_id=${parent.id}`;
        const resParams = await fetch(urlParams);
        const dataParams = await resParams.json();
        console.log(`Query: parent_category_id -> Count: ${dataParams.product_categories?.length || 0}`);

    } catch (e) {
        console.error(e);
    }
}

test();
