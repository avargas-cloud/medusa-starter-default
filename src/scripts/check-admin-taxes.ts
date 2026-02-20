import 'dotenv/config';

const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || 'http://localhost:9000';
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || 'admin@ecopowertech.com';
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || 'Ecopower!123';

async function adminFetch(path: string, options: RequestInit = {}) {
    // 1. Authenticate to get session token
    const authRes = await fetch(`${MEDUSA_URL}/admin/auth/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    });

    if (!authRes.ok) {
        throw new Error(`Auth failed: ${await authRes.text()}`);
    }
    const { token } = await authRes.json();

    // 2. Fetch the resource
    const res = await fetch(`${MEDUSA_URL}${path}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    try {
        const text = await res.text();
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function runTaxCheck() {
    console.log("Checking Admin Regions & Taxes...");

    const regions = await adminFetch('/admin/regions');
    if (!regions?.regions) {
        console.log("Failed to fetch regions or no regions configured.");
        return;
    }

    for (const r of regions.regions) {
        console.log(`\nRegion: ${r.name} (Currency: ${r.currency_code})`);
        console.log(`Default Tax Rate: ${r.tax_rate}`);
        console.log(`Includes Tax: ${r.includes_tax}`);

        // Fetch Tax Providers/Rates for this region
        const rates = await adminFetch(`/admin/tax-rates?region_id=${r.id}`);
        console.log(`Configured Tax Rates:`, rates?.tax_rates || []);
    }
}

runTaxCheck();
