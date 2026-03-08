require('dotenv').config({ path: '/home/alejo/webapps/ecopowertech-workspace/backend/.env' });

async function checkTasks() {
    const url = `${process.env.MEILISEARCH_HOST}/tasks?limit=5`;
    console.log("Fetching:", url);
    try {
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${process.env.MEILISEARCH_API_KEY}` }
        });
        const data = await res.json();
        console.log(JSON.stringify(data.results.slice(0, 3), null, 2));
    } catch (e) {
        console.error(e);
    }
}
checkTasks();
