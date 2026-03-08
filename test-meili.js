const { MeiliSearch } = require('meilisearch');
require('dotenv').config({ path: '/home/alejo/webapps/ecopowertech-workspace/ecopowertech-store-pos/.env.local' });

const client = new MeiliSearch({
    host: process.env.NEXT_PUBLIC_MEILISEARCH_HOST,
    apiKey: process.env.NEXT_PUBLIC_MEILISEARCH_SEARCH_KEY
});

async function run() {
    try {
        const res = await client.index('customers').search('Jorge Carvajal', { limit: 1 });
        console.log("Customer Document from Meilisearch:");
        console.log(JSON.stringify(res.hits[0], null, 2));
    } catch (e) {
        console.error(e);
    }
}
run();
