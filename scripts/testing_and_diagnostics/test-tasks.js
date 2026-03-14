const { MeiliSearch } = require('meilisearch');
require('dotenv').config({ path: '/home/alejo/webapps/ecopowertech-workspace/backend/.env' });

const client = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST,
    apiKey: process.env.MEILISEARCH_API_KEY
});

async function run() {
    try {
        const tasks = await client.getTasks({ limit: 5 });
        console.log(JSON.stringify(tasks.results, null, 2));
    } catch (e) {
        console.error(e)
    }
    process.exit(0);
}
run();
