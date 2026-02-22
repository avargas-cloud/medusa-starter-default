# Authentication Scripts Reference

**Last Updated**: 2026-02-03  
**Location**: `/src/scripts/`

---

## Active/Useful Scripts

### E2E Testing

#### `test-auth-e2e.ts` ⭐ **PRIMARY TEST**
Complete end-to-end authentication test covering password reset + login flows.

**Usage**:
```bash
npx -y tsx src/scripts/test-auth-e2e.ts
```

**What it tests**:
1. ✅ Request password reset
2. ✅ Retrieve token from database
3. ✅ Confirm password reset (scrypt-kdf)
4. ✅ Login with custom endpoint
5. ✅ Login with Medusa gold standard endpoint

**Test credentials**: `a.vargas@ecopowertech.com` / `TestPassword123!`

---

### Diagnostic Scripts

#### `diagnose-customer.ts`
Complete diagnostic check for customer account state.

**Usage**:
```bash
npx -y tsx src/scripts/diagnose-customer.ts
```

**Shows**:
- Customer existence and status
- `has_account` flag
- Metadata (legacy_customer, tokens, etc.)
- Auth records (auth_identity + provider_identity)

---

#### `check-reset-tokens.ts`
Quick check for active password reset tokens in database.

**Usage**:
```bash
npx -y tsx src/scripts/check-reset-tokens.ts
```

**Shows**:
- All customers with active reset tokens
- Token expiration dates
- Token validity

---

### Account Management

#### `force-reset-legacy.ts` ⭐ **RESET ACCOUNT**
Robust script to force-reset account to clean legacy state.

**Usage**:
```bash
npx -y tsx src/scripts/force-reset-legacy.ts
```

**What it does**:
1. Deletes all `provider_identity` records
2. Deletes all `auth_identity` records
3. Sets `has_account = false`
4. Clears metadata to clean legacy state
5. Verifies final state

**Use when**: Need to test Case 3 (legacy activation) from scratch

---

#### `get-activation-token.ts`
Extract activation token from customer metadata.

**Usage**:
```bash
npx -y tsx src/scripts/get-activation-token.ts
```

**Use when**: Testing Case 3 activation flow manually

---

## Deprecated Scripts

**Location**: `/src/scripts/_deprecated/auth-scripts/`

These scripts have been replaced by better versions:

| Deprecated Script | Replaced By | Reason |
|-------------------|-------------|--------|
| `unregister-customer.ts` | `force-reset-legacy.ts` | More robust with verification |
| `test-password-reset-flow.ts` | `test-auth-e2e.ts` | More complete E2E test |
| `check-token.ts` | `check-reset-tokens.ts` | Simpler interface |
| `check-provider-metadata.ts` | `diagnose-customer.ts` | More comprehensive |
| `test-sql-transaction.ts` | N/A | Temporary debug script |

---

## Testing Workflows

### Test Password Reset (Full Flow)

```bash
# 1. Make sure account HAS account
npx -y tsx src/scripts/diagnose-customer.ts
# Should show: has_account = true

# 2. Run E2E test
npx -y tsx src/scripts/test-auth-e2e.ts

# Expected: All 5 steps pass ✅
```

### Test Legacy Activation (Case 3)

```bash
# 1. Reset account to legacy
npx -y tsx src/scripts/force-reset-legacy.ts

# 2. Verify state
npx -y tsx src/scripts/diagnose-customer.ts
# Should show: has_account = false, No auth records

# 3. Test from frontend
# - Go to /register
# - Enter email + password
# - Should receive activation email
# - Click link → auto-login
```

### Diagnose Login Issues

```bash
# 1. Check account state
npx -y tsx src/scripts/diagnose-customer.ts

# 2. If has_account = false
# → User needs activation (Case 3), not password reset

# 3. If has_account = true but login fails
# → Check auth records exist
# → Verify password hash format in provider_metadata
```

---

## Common Issues

### "Invalid or expired reset token"

**Cause**: Token not found or user has `has_account = false`

**Solution**:
```bash
# Check account state
npx -y tsx src/scripts/diagnose-customer.ts

# If has_account = false:
# Password reset won't work. User needs Case 3 activation.
```

### "Invalid key" login error

**Cause**: Password hash not stored correctly (wrong algorithm or field)

**Solution**: Verify password stored in `provider_metadata.password` as base64 scrypt-kdf hash

### Reset token shows as timestamp number

**Cause**: Old code saved `reset_expires` as `Date.now()` instead of ISO string

**Fixed in**: `src/api/store/auth/reset-password/route.ts` (line 63)

---

## Quick Reference

| Task | Script | Expected Result |
|------|--------|----------------|
| Test complete auth flow | `test-auth-e2e.ts` | All 5 steps pass |
| Check account status | `diagnose-customer.ts` | Full account details |
| Reset to legacy | `force-reset-legacy.ts` | Clean legacy state |
| Check reset tokens | `check-reset-tokens.ts` | Active tokens list |
| Get activation token | `get-activation-token.ts` | Token from metadata |

---

**Maintained by**: EcoPowerTech Development Team  
**Last Verified**: 2026-02-03
