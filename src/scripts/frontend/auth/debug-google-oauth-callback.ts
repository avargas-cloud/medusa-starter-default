#!/usr/bin/env tsx
/**
 * Google OAuth Callback Debugger
 * 
 * Diagnoses issues with Google OAuth callback flow
 */

import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || 'http://localhost:9000';

async function debugGoogleOAuthCallback() {
    console.log('\n🔍 GOOGLE OAUTH CALLBACK DIAGNOSTIC\n');
    console.log('━'.repeat(60));

    // Step 1: Verify environment variables
    console.log('\n📋 STEP 1: Environment Configuration');
    console.log('━'.repeat(60));

    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const storefrontUrl = process.env.STOREFRONT_URL;
    const backendUrl = process.env.MEDUSA_BACKEND_URL;

    console.log(`✅ GOOGLE_CLIENT_ID: ${googleClientId ? '✓ Set' : '❌ Missing'}`);
    console.log(`✅ GOOGLE_CLIENT_SECRET: ${googleClientSecret ? '✓ Set' : '❌ Missing'}`);
    console.log(`✅ STOREFRONT_URL: ${storefrontUrl || 'http://localhost:4321 (default)'}`);
    console.log(`✅ MEDUSA_BACKEND_URL: ${backendUrl || 'http://localhost:9000 (default)'}`);

    if (!googleClientId || !googleClientSecret) {
        console.log('\n❌ ERROR: Google OAuth credentials not configured');
        process.exit(1);
    }

    // Step 2: Check which callback routes exist
    console.log('\n📋 STEP 2: Callback Route Detection');
    console.log('━'.repeat(60));

    const routes = [
        '/auth/customer/google/callback',
        '/store/auth/google/callback'
    ];

    for (const route of routes) {
        try {
            // Try HEAD request first (lightweight)
            const response = await axios.head(`${BACKEND_URL}${route}`, {
                maxRedirects: 0,
                validateStatus: () => true
            });

            if (response.status === 404) {
                console.log(`❌ ${route} - NOT FOUND (404)`);
            } else {
                console.log(`✅ ${route} - EXISTS (HTTP ${response.status})`);
            }
        } catch (error: any) {
            if (error.code === 'ECONNREFUSED') {
                console.log(`⚠️  Cannot connect to ${BACKEND_URL}`);
                console.log(`   Make sure backend is running with: ./back`);
                process.exit(1);
            }
            console.log(`⚠️  ${route} - ${error.message}`);
        }
    }

    // Step 3: Verify callback URL matches Google Cloud Console
    console.log('\n📋 STEP 3: Callback URL Configuration');
    console.log('━'.repeat(60));

    const configuredCallback = `${backendUrl}/auth/customer/google/callback`;
    console.log(`\n✅ Configured in medusa-config.ts:`);
    console.log(`   ${configuredCallback}`);

    console.log(`\n⚠️  IMPORTANT: This must match EXACTLY in Google Cloud Console:`);
    console.log(`   1. Go to: https://console.cloud.google.com/apis/credentials`);
    console.log(`   2. Select your OAuth 2.0 Client ID`);
    console.log(`   3. Under "Authorized redirect URIs", verify:`);
    console.log(`      ${configuredCallback}`);

    // Step 4: Test initiate endpoint
    console.log('\n📋 STEP 4: OAuth Initiate Endpoint Test');
    console.log('━'.repeat(60));

    try {
        const response = await axios.get(`${BACKEND_URL}/auth/customer/google`, {
            maxRedirects: 0,
            validateStatus: () => true
        });

        if (response.status === 302 || response.status === 301) {
            const redirectUrl = response.headers.location;
            console.log(`✅ Initiate endpoint working (HTTP ${response.status})`);
            console.log(`   Redirects to: ${redirectUrl?.substring(0, 50)}...`);

            if (redirectUrl?.includes('accounts.google.com')) {
                console.log(`   ✅ Redirects to Google OAuth (correct)`);
            } else {
                console.log(`   ❌ Does NOT redirect to Google`);
            }
        } else {
            console.log(`❌ Initiate endpoint returned HTTP ${response.status}`);
            console.log(`   Expected: 302 redirect to Google`);
        }
    } catch (error: any) {
        console.log(`❌ Error testing initiate endpoint: ${error.message}`);
    }

    // Step 5: Common issues checklist
    console.log('\n📋 STEP 5: Common Issues Checklist');
    console.log('━'.repeat(60));

    console.log(`\n❓ If login fails, check:`);
    console.log(`   1. ✓ Google Cloud Console has correct callback URL`);
    console.log(`   2. ✓ OAuth consent screen is configured`);
    console.log(`   3. ✓ Test users added (if app is in testing mode)`);
    console.log(`   4. ✓ Backend server is running (./back)`);
    console.log(`   5. ✓ No CORS errors in browser console`);
    console.log(`   6. ✓ Cookies enabled in browser`);

    console.log('\n━'.repeat(60));
    console.log('✅ Diagnostic complete\n');
}

debugGoogleOAuthCallback().catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
});
