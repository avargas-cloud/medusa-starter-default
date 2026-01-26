# Node.js v12 Compatibility Notes

## Changes Made for Windows Server 2008

Windows Server 2008 only supports Node.js up to v12.22.12, so we've made the following adjustments:

### 1. TypeScript Configuration
- **Target:** ES2019 (instead of ES2020)
- **Lib:** ES2019

### 2. Dependencies Downgraded
- TypeScript: v4.9.5 (from v5.3.3)
- @types/node: v12.20.55 (from v20.10.5)
- @types/uuid: v8.3.4 (from v9.0.7)
- Jest: v27.5.1 (from v29.7.0)
- ESLint: v7.32.0 (from v8.56.0)
- Prettier: v2.8.8 (from v3.1.1)
- Nodemon: v2.0.22 (from v3.0.2)

### 3. Features Avoided
The code intentionally avoids:
- ❌ Optional chaining (`?.`) - Not supported in Node v12
- ❌ Nullish coalescing (`??`) - Not supported in Node v12  
- ❌ `String.prototype.replaceAll()` - Not available in Node v12
- ❌ `Promise.any()` - Not available in Node v12
- ✅ Used `||` instead of `??`
- ✅ Used traditional property access instead of `?.`

### 4. Code Compatibility
All code has been written to be compatible with:
- Node.js v12.22.12+
- Windows Server 2008
- QuickBooks Enterprise 2012

### Installation on Windows Server 2008

**Recommended Node.js version:**
```
https://nodejs.org/dist/v12.22.12/node-v12.22.12-x64.msi
```

Or for 32-bit systems:
```
https://nodejs.org/dist/v12.22.12/node-v12.22.12-x86.msi
```

### If Dependencies Fail to Install

Some newer versions of npm packages might not work with Node v12. If you encounter errors during `npm install`, try:

```powershell
# Use legacy peer deps
npm install --production --legacy-peer-deps

# Or force install
npm install --production --force
```

### Testing

After installation, verify everything works:

```powershell
# Check Node version
node --version  # Should show v12.x.x

# Install dependencies
npm install --production

# Compile TypeScript
npm run build

# Test the service
npm start
```

## Known Limitations

- Winston logger might have reduced functionality
- Some newer npm packages may require older versions
- Performance might be slightly reduced compared to Node.js v18+
