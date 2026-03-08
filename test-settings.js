const { MeiliSearch } = require('meilisearch');
require('dotenv').config({ path: '/home/alejo/webapps/ecopowertech-workspace/backend/.env' });

const client = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST,
    apiKey: process.env.MEILISEARCH_API_KEY
});

async function run() {
    try {
        const settings = await client.index('customers').getSettings();
        console.log('Current Settings:', JSON.stringify(settings, null, 2));

        let displayed = settings.displayedAttributes || [];
        if (displayed.length > 0 && displayed[0] !== '*') {
            const needed = ['customer_type', 'price_level', 'acquisition_channel', 'list_id', 'status', 'has_account', 'created_at'];
            const newDisplayed = Array.from(new Set([...displayed, ...needed]));
            console.log('Updating displayed attributes to:', newDisplayed);
            await client.index('customers').updateDisplayedAttributes(newDisplayed);
        }

        let filterable = settings.filterableAttributes || [];
        const neededFilterable = ['customer_type', 'price_level', 'status'];
        const newFilterable = Array.from(new Set([...filterable, ...neededFilterable]));
        if (newFilterable.length > filterable.length) {
            console.log('Updating filterable attributes to:', newFilterable);
            await client.index('customers').updateFilterableAttributes(newFilterable);
        }

        console.log('Done!');
    } catch (e) {
        console.error(e)
    }
    process.exit(0);
}
run();
