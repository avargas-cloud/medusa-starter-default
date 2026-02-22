const knex = require('knex')({
    client: 'pg',
    connection: process.env.DATABASE_URL
});

(async () => {
    const customer = await knex('customer')
        .where('email', 'a.vargas@ecopowertech.com')
        .first('email', 'has_account', 'metadata');

    console.log('📧 Email:', customer.email);
    console.log('🔐 has_account:', customer.has_account);
    console.log('🏷️  legacy_customer:', customer.metadata?.legacy_customer);
    console.log('📅 activated_at:', customer.metadata?.activated_at);
    console.log('');

    // Check if auth exists
    const authCount = await knex('provider_identity')
        .where('entity_id', 'a.vargas@ecopowertech.com')
        .count('* as count')
        .first();

    console.log('🔑 Auth identities:', authCount.count);
    console.log('');

    if (customer.has_account === true || authCount.count > 0 || !customer.metadata?.legacy_customer) {
        console.log('❌ CUENTA YA ACTIVADA - Ejecutando reset...');

        // Delete auth
        await knex('provider_identity').where('entity_id', 'a.vargas@ecopowertech.com').del();

        // Reset customer
        await knex('customer')
            .where('email', 'a.vargas@ecopowertech.com')
            .update({
                has_account: false,
                metadata: knex.raw("jsonb_set(COALESCE(metadata, '{}'::jsonb) - 'activated_at', '{legacy_customer}', 'true')")
            });

        console.log('✅ CUENTA RESETEADA - Lista para probar');
    } else {
        console.log('✅ CUENTA LEGACY VIRGEN - Lista para probar');
    }

    await knex.destroy();
    process.exit(0);
})();
