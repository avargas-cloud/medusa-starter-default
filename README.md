<p align="center">
  <a href="https://www.medusajs.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://user-images.githubusercontent.com/59018053/229103275-b5e482bb-4601-46e6-8142-244f531cebdb.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://user-images.githubusercontent.com/59018053/229103726-e5b529a3-9b3f-4970-8a1f-c6af37f087bf.svg">
    <img alt="Medusa logo" src="https://user-images.githubusercontent.com/59018053/229103726-e5b529a3-9b3f-4970-8a1f-c6af37f087bf.svg">
    </picture>
  </a>
</p>
<h1 align="center">
  Medusa
</h1>

<h4 align="center">
  <a href="https://docs.medusajs.com">Documentation</a> |
  <a href="https://www.medusajs.com">Website</a>
</h4>

<p align="center">
  Building blocks for digital commerce
</p>
<p align="center">
  <a href="https://github.com/medusajs/medusa/blob/master/CONTRIBUTING.md">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat" alt="PRs welcome!" />
  </a>
    <a href="https://www.producthunt.com/posts/medusa"><img src="https://img.shields.io/badge/Product%20Hunt-%231%20Product%20of%20the%20Day-%23DA552E" alt="Product Hunt"></a>
  <a href="https://discord.gg/xpCwq3Kfn8">
    <img src="https://img.shields.io/badge/chat-on%20discord-7289DA.svg" alt="Discord Chat" />
  </a>
  <a href="https://twitter.com/intent/follow?screen_name=medusajs">
    <img src="https://img.shields.io/twitter/follow/medusajs.svg?label=Follow%20@medusajs" alt="Follow @medusajs" />
  </a>
</p>

## Compatibility

This starter is compatible with versions >= 2 of `@medusajs/medusa`. 

## Getting Started

Visit the [Quickstart Guide](https://docs.medusajs.com/learn/installation) to set up a server.

Visit the [Docs](https://docs.medusajs.com/learn/installation#get-started) to learn more about our system requirements.

## Troubleshooting & Railway Deployment

### 🔴 Problem: "Ghost Admin User" (401 Unauthorized) in Railway
If you deployed to Railway and your login works but you get `401 Unauthorized` errors when accessing the dashboard:
*   **Cause:** The Auth Identity (EmailPass) exists, but it's not linked to an Admin User entity. This happens if the bootstrap command didn't run or failed.
*   **Missing Web Shell:** Railway's new UI (2026) hides the Web Shell, making it hard to run the fix command.

### ✅ Solution: Create Admin via Remote CLI
You must use the Railway CLI to execute the creation command on the live server:

1.  **Install Railway CLI:**
    ```bash
    npm install -g @railway/cli
    ```
2.  **Login & Link Project:**
    ```bash
    railway login
    railway link
    ```
3.  **SSH into Container:**
    ```bash
    railway ssh
    ```
4.  **Create User (Inside SSH Session):**
    ```bash
    npx medusa user -e admin@ecopowertech.com -p Secret123*
    ```

## 📅 Jan 21, 2026: Complete Railway Deployment Guide
This is a **comprehensive, battle-tested guide** documenting the full deployment process to Railway, including all pitfalls encountered and their solutions.

---

## 🚀 Step-by-Step Deployment Process

### Prerequisites
- A Medusa v2 project initialized locally
- A GitHub account with your Medusa repo pushed
- A Railway account (Hobby Plan recommended for production)

### Phase 1: Initial Railway Setup

#### 1. Create Railway Project
1. Go to [railway.app](https://railway.app)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your Medusa repository
4. Railway will automatically detect it's a Node.js project

#### 2. Add Required Services
Railway needs three services for Medusa:

**A. PostgreSQL Database**
1. In your Railway project, click **"+ New"**
2. Select **"Database"** → **"Add PostgreSQL"**
3. Railway automatically creates a `DATABASE_URL` variable

**B. Redis**
1. Click **"+ New"** again
2. Select **"Database"** → **"Add Redis"**
3. Railway automatically creates a `REDIS_URL` variable

**C. Medusa Application**
- This is your main service (already created from GitHub)

---

### Phase 2: Critical Configuration (`medusa-config.ts`)

⚠️ **IMPORTANT**: These configurations are REQUIRED for Railway deployment. The default starter template uses in-memory modules that will fail in production.

#### 1. Configure Redis Modules

Railway's ephemeral containers require external Redis for persistence. Update your `medusa-config.ts`:

```typescript
import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
    cookieOptions: {
      sameSite: "none",
      secure: true,
      maxAge: 10 * 60 * 60 * 1000, // 10 hours
    }
  },
  modules: [
    // ✅ CRITICAL: Event Bus with Redis (replaces in-memory)
    {
      resolve: "@medusajs/medusa/event-bus-redis",
      options: {
        redisUrl: process.env.REDIS_URL,
      },
    },
    // ✅ CRITICAL: Locking with Redis
    {
      resolve: "@medusajs/medusa/locking",
      options: {
        redisUrl: process.env.REDIS_URL,
      },
    },
    // ✅ CRITICAL: Cache with Redis (replaces in-memory)
    {
      resolve: "@medusajs/medusa/cache-redis",
      options: {
        redisUrl: process.env.REDIS_URL,
      },
    },
    // ✅ CRITICAL: Workflows with Redis
    {
      resolve: "@medusajs/medusa/workflow-engine-redis",
      options: {
        redis: {
          url: process.env.REDIS_URL,
        },
      },
    },
  ],
})
```

**Why this is critical:**
- Default in-memory modules lose data on container restart
- Railway containers are ephemeral and restart frequently
- Redis ensures persistence across deployments

#### 2. Commit and Push Changes

```bash
git add medusa-config.ts
git commit -m "Configure Redis modules for Railway deployment"
git push origin main
```

Railway will automatically redeploy when it detects the push.

---

### Phase 3: Environment Variables Configuration

Navigate to your Medusa service in Railway → **Variables** tab.

#### Required Variables

| Variable | Value | How to Generate | Critical? |
|----------|-------|----------------|-----------|
| `NODE_ENV` | `production` | Manual entry | ✅ CRITICAL |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Auto-linked by Railway | ✅ CRITICAL |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | Auto-linked by Railway | ✅ CRITICAL |
| `PORT` | `9000` | Manual entry | ✅ CRITICAL |
| `JWT_SECRET` | Random 32-char string | See below | ✅ CRITICAL |
| `COOKIE_SECRET` | Random 32-char string | See below | ✅ CRITICAL |
| `ADMIN_CORS` | Your Railway app URL | Copy from deployment | ✅ CRITICAL |
| `AUTH_CORS` | Your Railway app URL | Copy from deployment | ✅ CRITICAL |
| `STORE_CORS` | `http://localhost:8000` | Manual entry (update later) | Optional |

#### Generate Secure Secrets

**On Windows (PowerShell):**
```powershell
# Generate JWT_SECRET
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})

# Generate COOKIE_SECRET (run again for different value)
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})
```

**On macOS/Linux:**
```bash
# Generate JWT_SECRET
openssl rand -base64 32

# Generate COOKIE_SECRET
openssl rand -base64 32
```

⚠️ **Save these values securely** - you'll need them if you ever migrate or redeploy.

#### Critical Variables Explained

**`NODE_ENV=production`**
- **Why critical**: Without this, Medusa runs in development mode
- **Problem without it**: Cookies set with `secure: false` won't work over HTTPS
- **Symptom**: 401 Unauthorized errors even with correct credentials

**`PORT=9000`**
- **Why critical**: Railway expects your app to listen on a specific port
- **Problem without it**: "Application failed to respond" errors
- **Medusa default**: 9000

**`JWT_SECRET` and `COOKIE_SECRET`**
- **Why critical**: Used to sign authentication tokens and session cookies
- **Problem without it**: Sessions become invalid on redeploy, forcing re-login
- **NEVER use default values** (`supersecret`) in production

**`ADMIN_CORS` and `AUTH_CORS`**
- **Format**: `https://your-app-name.up.railway.app` (no trailing slash)
- **Why critical**: CORS blocks requests from unauthorized origins
- **Problem without it**: Admin panel can't communicate with backend API
- **Symptom**: Network errors in browser console, 401/403 responses

---

### Phase 4: Railway Service Settings

In Railway, select your Medusa service → **Settings** tab:

#### Build & Deploy Settings

**Build Command:**
```bash
npm install --legacy-peer-deps && npm run build
```

⚠️ **CRITICAL**: The `--legacy-peer-deps` flag is required because Railway's npm install can hang indefinitely with peer dependency conflicts in Medusa v2.12.5.

**Start Command:**
```bash
npm run start
```

#### Healthcheck Configuration

Click **Settings** → **Deploy** → **Healthcheck**:

- **Path**: `/health`
- **Timeout**: `300` seconds (5 minutes)
- **Interval**: Leave default

**Why this is critical:**
- Medusa takes 1-2 minutes to start (migrations, admin build)
- Default 30s timeout causes Railway to kill the container prematurely
- You'll see "deployment failed" even though the app would have started successfully

---

### Phase 5: Common Deployment Issues & Solutions

#### ❌ Issue #1: `npm install` Hangs Forever

**Symptom:**
```
npm install
[hangs for 15+ minutes, deployment fails]
```

**Cause:** Peer dependency conflicts in Medusa v2 packages

**Solution:**
Update build command to:
```bash
npm install --legacy-peer-deps && npm run build
```

---

#### ❌ Issue #2: Port Mismatch Error

**Symptom:**
```
Application failed to respond
Railway expected port 8080, but application is listening on 9000
```

**Cause:** Railway auto-detects port 8080, but Medusa uses 9000

**Solution:**
Add environment variable:
```
PORT=9000
```

---

#### ❌ Issue #3: Deployment Succeeds but Times Out

**Symptom:**
- Deployment shows "Success" but immediately restarts
- Logs show "Healthcheck failed"

**Cause:** Default 30-second healthcheck timeout is too short

**Solution:**
1. Go to Settings → Deploy → Healthcheck
2. Set timeout to **300 seconds**
3. Set path to `/health`

---

#### ❌ Issue #4: 401 Unauthorized After Login

**Symptom:**
- Login appears successful (200 OK response)
- Immediately redirected to login again
- `/admin/users/me` returns 401 Unauthorized
- Browser DevTools shows session cookie is being sent

**Debugging Steps:**
1. Open browser DevTools (F12) → Network tab
2. Attempt login
3. Check if login response includes `Set-Cookie: connect.sid=...`
4. Check if subsequent requests include `Cookie: connect.sid=...`

**Possible Causes & Solutions:**

**A. `NODE_ENV` not set to `production`**
- Medusa sets cookies with `secure: false` in development
- HTTPS requires `secure: true`
- **Solution**: Add `NODE_ENV=production` to Railway variables

**B. `COOKIE_SECRET` Changed**
- If you change `COOKIE_SECRET` after users logged in, their cookies become invalid
- **Solution**: Generate new secrets BEFORE first deployment, then never change them
- Use strong random values (see "Generate Secure Secrets" above)

**C. `ADMIN_CORS` or `AUTH_CORS` Misconfigured**
- Must match EXACT deployment URL (no trailing slash)
- **Wrong**: `https://myapp.up.railway.app/`
- **Right**: `https://myapp.up.railway.app`
- **Solution**: Copy URL from Railway dashboard, remove trailing slash

**D. Browser Cookie Cache**
- Old cookies from previous deployments can conflict
- **Solution**: 
  - Clear browser cookies for the domain
  - Use Incognito/Private browsing mode
  - Try different browser

---

#### ❌ Issue #5: "Ghost Admin User" (401 After Successful Login)

**Symptom:**
- Login succeeds and returns a JWT token
- Token payload shows `"actor_id": ""`  (empty)
- All admin API calls return 401 Unauthorized

**Cause:** 
The EmailPass auth identity exists, but it's not linked to an actual Admin User entity in the database.

**Solution: Create User via Railway CLI**

1. **Install Railway CLI:**
   ```bash
   npm install -g @railway/cli
   ```

2. **Login to Railway:**
   ```bash
   railway login
   ```

3. **Link to Your Project:**
   ```bash
   cd /path/to/medusa-project
   railway link
   ```
   Select your project and service when prompted.

4. **SSH into Container:**
   ```bash
   railway ssh
   ```

5. **Create Admin User (inside SSH session):**
   ```bash
   npx medusa user -e admin@yourcompany.com -p YourSecurePassword123
   ```

6. **Exit SSH:**
   ```bash
   exit
   ```

7. **Test Login:**
   - Go to `https://your-app.up.railway.app/app`
   - Login with the credentials you just created

---

### Phase 6: Verification Checklist

After deployment completes, verify everything works:

- [ ] **Deployment Status**: Railway shows "Active" (green)
- [ ] **Health Check**: `/health` endpoint returns 200 OK
- [ ] **Database Connected**: Check logs for "Database connected" message
- [ ] **Redis Connected**: Check logs for "Redis connected" or no Redis errors
- [ ] **Admin Panel Loads**: Visit `https://your-app.up.railway.app/app`
- [ ] **Login Works**: Can login with admin credentials
- [ ] **Dashboard Accessible**: After login, can access orders/products pages
- [ ] **No 401 Errors**: Browser Network tab shows successful API calls
- [ ] **Session Persists**: Refresh page doesn't log you out

---

### Phase 7: Post-Deployment Configuration

#### Update CORS for Production Storefront

Once you deploy your storefront:

1. Go to Railway → Variables
2. Update `STORE_CORS`:
   ```
   https://your-storefront.com,http://localhost:8000
   ```
3. Update `AUTH_CORS`:
   ```
   https://your-app.up.railway.app,https://your-storefront.com
   ```

#### Configure Custom Domain (Optional)

1. Railway Settings → Domains
2. Add custom domain
3. Update DNS records as instructed
4. Update `ADMIN_CORS` to your custom domain

---

## 🔒 Security Checklist

Before going to production:

- [ ] Changed `JWT_SECRET` from default value
- [ ] Changed `COOKIE_SECRET` from default value
- [ ] Set `NODE_ENV=production`
- [ ] Configured CORS to only allow your domains
- [ ] Secured admin credentials (not "supersecret123")
- [ ] Enabled HTTPS (automatic on Railway)
- [ ] Reviewed Railway logs for exposed secrets

---

## 📊 Configuration Reference

### Complete Environment Variables Example

```bash
# Core
NODE_ENV=production
PORT=9000

# Database & Cache
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
DB_NAME=medusa-v2

# Security
JWT_SECRET=k2nmdEsaqWvfUGcKjTBuCyVYHR675hZg
COOKIE_SECRET=8p7y0mdiZl9zaN4ntjcAx56MIJqQGUFh

# CORS
ADMIN_CORS=https://medusa-starter-default-production-b69e.up.railway.app
AUTH_CORS=https://medusa-starter-default-production-b69e.up.railway.app
STORE_CORS=http://localhost:8000,https://docs.medusajs.com

# Worker Mode (optional, for cost optimization)
WORKER_MODE=server
```

### Complete `medusa-config.ts` Example

See Phase 2, Step 1 above for the complete configuration file.

---

## 🆘 Getting Help

If you encounter issues:

1. **Check Railway Logs**: Click on your service → Logs tab
2. **Search for Errors**: Look for keywords like "error", "failed", "unauthorized"
3. **Browser DevTools**: F12 → Console and Network tabs
4. **Medusa Discord**: [discord.gg/medusajs](https://discord.gg/medusajs)
5. **Railway Discord**: [discord.gg/railway](https://discord.gg/railway)

---

## 📝 Deployment Summary

**What We Configured:**
- Redis modules (event bus, cache, locking, workflows)
- Environment variables (11 total)
- Build command with `--legacy-peer-deps`
- Healthcheck with 300s timeout
- Cookie options for HTTPS
- Port configuration (9000)

**What We Fixed:**
- npm install hanging → `--legacy-peer-deps`
- Port mismatch → `PORT=9000`
- Healthcheck timeout → 300 seconds
- 401 errors → `NODE_ENV=production` + strong secrets
- Ghost user → Railway CLI user creation

**Deployment Time:** ~5-10 minutes (after configuration is correct)

**Cost:** ~$5-10/month on Railway Hobby Plan (for starter projects)

---

## What is Medusa

Medusa is a set of commerce modules and tools that allow you to build rich, reliable, and performant commerce applications without reinventing core commerce logic. The modules can be customized and used to build advanced ecommerce stores, marketplaces, or any product that needs foundational commerce primitives. All modules are open-source and freely available on npm.

Learn more about [Medusa’s architecture](https://docs.medusajs.com/learn/introduction/architecture) and [commerce modules](https://docs.medusajs.com/learn/fundamentals/modules/commerce-modules) in the Docs.

## Build with AI Agents

### Claude Code Plugin

If you use AI agents like Claude Code, check out the [medusa-dev Claude Code plugin](https://github.com/medusajs/medusa-claude-plugins).

### Other Agents

If you use AI agents other than Claude Code, copy the [skills directory](https://github.com/medusajs/medusa-claude-plugins/tree/main/plugins/medusa-dev/skills) into your agent's relevant `skills` directory.

### MCP Server

You can also add the MCP server `https://docs.medusajs.com/mcp` to your AI agents to answer questions related to Medusa. The `medusa-dev` Claude Code plugin includes this MCP server by default.

## Community & Contributions

The community and core team are available in [GitHub Discussions](https://github.com/medusajs/medusa/discussions), where you can ask for support, discuss roadmap, and share ideas.

Join our [Discord server](https://discord.com/invite/medusajs) to meet other community members.

## Other channels

- [GitHub Issues](https://github.com/medusajs/medusa/issues)
- [Twitter](https://twitter.com/medusajs)
- [LinkedIn](https://www.linkedin.com/company/medusajs)
- [Medusa Blog](https://medusajs.com/blog/)
