/**
 * scripts/debug/get-gmail-refresh-token.ts
 *
 * One-time script to obtain a Gmail OAuth2 refresh token.
 * Spins up a local HTTP server to capture the OAuth callback (loopback redirect).
 *
 * Usage:
 *   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=xxx npx ts-node src/scripts/debug/get-gmail-refresh-token.ts
 */

import { auth as gauth } from "@googleapis/gmail";
import * as http from "http";

const CLIENT_ID = process.env.GMAIL_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET ?? "";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "\n❌  Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET before running.\n"
  );
  process.exit(1);
}

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.insert"];

const oauth2Client = new gauth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",
});

console.log(
  "\n─────────────────────────────────────────────────────────────────"
);
console.log("  Gmail OAuth2 — Refresh Token Generator");
console.log(
  "─────────────────────────────────────────────────────────────────"
);
console.log(`\nListening on http://localhost:${PORT} for OAuth callback...`);
console.log(
  "\nOpen this URL in your browser (logged in as a.arenas@ecopowertech.com):\n"
);
console.log(`  ${authUrl}\n`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h2>Error: ${error}</h2><p>You can close this tab.</p>`);
    console.error(`\n❌  OAuth error: ${error}\n`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h2>No code received.</h2>`);
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
            <html><body style="font-family:monospace;padding:2rem;background:#111;color:#0f0">
            <h2>✅ Success! Check your terminal for the env vars.</h2>
            <p>You can close this tab.</p>
            </body></html>
        `);

    console.log(
      "\n─────────────────────────────────────────────────────────────────"
    );
    console.log("  ✅  Success! Add these to backend/.env:");
    console.log(
      "─────────────────────────────────────────────────────────────────\n"
    );
    console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`GMAIL_SENDER_EMAIL=a.arenas@ecopowertech.com`);
    console.log(
      "\n─────────────────────────────────────────────────────────────────\n"
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Error: ${msg}`);
    console.error(`\n❌  Error exchanging code: ${msg}\n`);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);
