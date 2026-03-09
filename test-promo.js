const fetch = require('node-fetch');

async function test() {
    const loginRes = await fetch("http://localhost:9000/auth/user/emailpass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "sales@ecopowertech.com", password: "Ecuador2024!" })
    });
    const { token } = await loginRes.json();

    const promoRes = await fetch("http://localhost:9000/admin/pos-promotions", {
        headers: { "Authorization": `Bearer ${token}` }
    });
    const text = await promoRes.text();
    console.log("Status:", promoRes.status);
    console.log("Response:", text);
}

test();
