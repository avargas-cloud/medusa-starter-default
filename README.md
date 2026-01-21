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

## 📅 Jan 21, 2026: Full Deployment & Configuration Log
This section serves as a complete record of the configuration required to deploy Medusa v2 on Railway.

### 1. Environment Variables (Railway)
The following variables were configured in the Railway Dashboard to enable production connectivity:

| Variable | Value / Description | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Optimizes build and runtime performance. |
| `DATABASE_URL` | `postgresql://...` | Connection string to the Railway Postgres service. |
| `REDIS_URL` | `redis://...` | Connection string to the Railway Redis service. |
| `JWT_SECRET` | `[Secure Value]` | Signs Auth Tokens. |
| `COOKIE_SECRET` | `[Secure Value]` | Signs Session Cookies. |
| `STORE_CORS` | `http://localhost:8000,...` | Allowed Storefront URLs. |
| `ADMIN_CORS` | `http://localhost:5173,...` | Allowed Admin Dashboard URLs. |
| `AUTH_CORS` | `http://localhost:5173,...` | Allowed Auth URLs. |
| `WORKER_MODE` | `server` | Runs the worker process alongside the server (Cost efficient for starters). |

### 2. Railway Service Configuration
*   **Trust Proxy:** Enabled automatically (or explicitly via `trustProxy: true` in newer configs) to handle Railway's internal load balancers correctly. This prevents infinite redirect loops and correct IP detection.
*   **Root Directory:** `/` (Default).
*   **Build Command:** `medusa build` (Ensures admin dashboard is compiled).
*   **Start Command:** `medusa start` (Runs the application).

### 3. Codebase Configurations (`medusa-config.ts`)
We updated the configuration to support the Serverless/Containerized architecture:

#### A. Redis Modules (Event Bus & Cache)
In-memory event buses fail in serverless deployments. We activated Redis-backed modules:
```typescript
{
  resolve: "@medusajs/medusa/event-bus-redis", 
  options: { redisUrl: process.env.REDIS_URL }
},
{
  resolve: "@medusajs/medusa/cache-redis", 
  options: { redisUrl: process.env.REDIS_URL }
}
```

#### B. Cookie Security (Cross-Domain)
To allow the Admin Dashboard (often on a different domain or protocol during dev) to talk to the backend:
```typescript
cookieOptions: {
  sameSite: "none",
  secure: true,
  maxAge: 10 * 60 * 60 * 1000,
}
```

### 4. Troubleshooting: Admin User (The "Ghost User" Fix)
**Issue:** Login returned `401 Unauthorized` despite correct password. Token showed empty `actor_id`.
**Cause:** The Auth Identity existed but wasn't linked to an Admin User entity.
**Fix (Remote CLI):**
Because Railway's Web Shell is sometimes unavailable, we used the remote CLI:
```bash
railway login
railway link
railway ssh
# Inside the container:
npx medusa user -e admin@ecopowertech.com -p Secret123*
```

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
