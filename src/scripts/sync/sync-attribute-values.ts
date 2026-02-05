/**
 * Quick fix: Just re-save your "Test" attribute in the admin
 * Or run this endpoint manually to sync all attributes
 */

// Manual API call to sync an attribute
// Replace ATTRIBUTE_ID with your actual attribute ID

async function syncAttribute(attributeId: string) {
    const response = await fetch(`http://localhost:9000/admin/attributes/${attributeId}`, {
        method: 'GET',
    })

    const data = await response.json()
    const attribute = data.attribute

    // Re-save with same data to trigger sync
    await fetch(`http://localhost:9000/admin/attributes/${attributeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            label: attribute.label,
            options: attribute.options // This will trigger the sync
        })
    })

    console.log(`✅ Synced ${attribute.label}`)
}

// Example usage:
// syncAttribute("01KG5NQ5ZVQ0Z0B638SV6N7W3T")
