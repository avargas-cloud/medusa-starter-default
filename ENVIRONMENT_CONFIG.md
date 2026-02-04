# Environment Configuration Guide

## 🎯 Simple Automatic Environment Detection

This project uses **single `.env` file** with automatic dev/prod detection. Just change `NODE_ENV` and everything adapts automatically.

## 🔄 How It Works

Your `.env` file has ONE variable that controls everything:

```bash
NODE_ENV=development  # For local dev
# or
NODE_ENV=production   # For Railway deployment
```

### What Changes Automatically:

| Setting | Development | Production |
|---------|------------|------------|
| **STORE_CORS** | `localhost:4321` | `ecopowertech.com` |
| **AUTH_CORS** | `localhost:4321` | `ecopowertech.com` |
| **ADMIN_CORS** | `localhost:5173` | Railway backend |
| **Backend URL** | `localhost:9000` | Railway backend |

## ✅ Benefits

1. ✅ **One File** - Single `.env` to manage
2. ✅ **One Variable** - Just change `NODE_ENV`
3. ✅ **No Forgetting** - Impossible to deploy with wrong URLs
4. ✅ **Git Safe** - `.env` is gitignored (secrets stay secret)

## 🚀 Usage

### Local Development
```bash
# In .env file:
NODE_ENV=development

# Run:
yarn dev
```
**Result:** Uses `localhost:4321`, `localhost:9000`, etc.

### Production Deployment (Railway)
```bash
# In Railway dashboard:
NODE_ENV=production

# Or in .env file before deploy:
NODE_ENV=production
```
**Result:** Uses `ecopowertech.com`, Railway URLs, etc.

## 🔧 Where The Magic Happens

File: `medusa-config.ts`

```typescript
// ✅ Smart CORS: Auto-detect dev vs production
storeCors: process.env.NODE_ENV === "production"
  ? "https://ecopowertech.com"
  : "http://localhost:4321",
```

## 🚨 Important Rules

### ❌ Never Commit
- `.env` - Contains secrets

### ✅ Always Commit  
- `medusa-config.ts` - Has the conditional logic
- `.env.template` - Example for new team members

## 🐛 Debugging

To verify which environment is active:
```bash
# Check .env file
cat .env | grep NODE_ENV

# See loaded config
yarn dev  # Check console logs
```

## 📋 Complete Setup Example

**`.env` file:**
```bash
# Just set this one variable!
NODE_ENV=development

# Database (same for dev and prod)
DATABASE_URL=postgresql://...

# Secrets (same for dev and prod)
JWT_SECRET=your-secret-here
COOKIE_SECRET=your-secret-here

# ...rest of config
```

**That's it!** All URLs auto-configure based on `NODE_ENV`.

---

**Last Updated:** 2026-02-02  
**Simplified by:** Backend Team
