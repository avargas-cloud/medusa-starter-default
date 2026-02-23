# Authentication Scripts Reference

**Last Updated**: 2026-02-23  
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

#### `force/force-reset-legacy.ts` ⭐ **RESET ACCOUNT**
Forza el reset de una cuenta específica a estado legacy limpio. Email hardcodeado: `a.vargas@ecopowertech.com`.

**Usage**:
```bash
npx -y tsx src/scripts/force/force-reset-legacy.ts
```

**What it does**:
1. Deletes all `provider_identity` records (by `entity_id`)
2. Deletes all `auth_identity` records (by `app_metadata.customer_id`)
3. Sets `has_account = false`
4. Clears metadata to `{ legacy_customer: true, reset_at: ... }`
5. Verifies final state via SELECT

**Use when**: Need to test Case 3 (legacy activation) from scratch

---

#### `delete/delete-and-recreate-customer.ts` ⭐ **DELETE for TESTING** *(nuevo, Feb 2026)*
Elimina todos los registros de auth y customer por email, opcionalmente con un email personalizado. Después imprime el CURL para recrear el usuario limpio.

**Usage**:
```bash
# Con email generado automáticamente (timestamp)
npx -y tsx src/scripts/delete/delete-and-recreate-customer.ts

# Con email específico
npx -y tsx src/scripts/delete/delete-and-recreate-customer.ts --email test@example.com
```

**What it does**:
1. Borra `provider_identity` donde `entity_id` o `user_metadata.email` = email
2. Borra `auth_identity` donde `app_metadata.email` = email
3. Borra `customer` donde `email` = email
4. Imprime CURL para re-registrar el usuario via `/store/auth/register`

**Use when**: Testing fresh registration flow; need a clean slate for a test email

---

#### `reset-legacy.ts` *(raíz de `/backend/`)* — **SCRIPT DE EMERGENCIA**
Script de una sola vez (usa `pg` directamente, no `postgres`). Hardcodeado para `alejosvp@gmail.com`. Se creó para resolver un caso urgente de auth. **No mover:** Railway podría necesitar ejecutarlo con `tsx reset-legacy.ts`.

**Usage**:
```bash
# Desde el directorio backend/
cd backend && npx tsx reset-legacy.ts
```

**What it does**:
1. Borra `provider_identity` del email (por `entity_id` y `provider_metadata`)
2. Hace UPDATE en `customer`: `has_account = false`, metadata `{legacy_customer: true}`

**Note (Feb 2026):** Corregido bug TS18047 — `res.rowCount ?? 0 > 0` en lugar de `res.rowCount > 0` para compatibilidad con `pg@8+` (Railway build).

---

### Get Utilities

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
| Test complete auth flow | `tests/test-auth-e2e.ts` | All 5 steps pass |
| Check account status | `diagnostics/diagnose-customer.ts` | Full account details |
| Reset to legacy (a.vargas) | `force/force-reset-legacy.ts` | Clean legacy state |
| Delete + recreate test customer | `delete/delete-and-recreate-customer.ts [--email x]` | Cuenta limpia para test |
| Emergency reset (alejosvp) | `../reset-legacy.ts` (raíz backend) | Legacy state |
| Check reset tokens | `checks/check-reset-tokens.ts` | Active tokens list |
| Get activation token | `get/get-activation-token.ts` | Token from metadata |

---

**Maintained by**: EcoPowerTech Development Team  
**Last Verified**: 2026-02-23
