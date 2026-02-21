---
**Purpose:** Navigation index for all authentication-related documents — maps each doc to its audience, use case, and best entry point for developers. Also contains a quick-start guide and critical implementation notes.

**Solves:** Prevents developers from reading the wrong doc first (e.g., reading the API spec when they need the implementation guide, or searching across 5 auth docs for the scrypt-kdf pattern).

**Expected Result:** Any developer starting work on auth can immediately find the right document for their task. Includes links to all auth-related test scripts and implementation files.

---

# Authentication Documentation Index

**EcoPowerTech Medusa v2 Backend**  
**Last Updated**: 2026-02-03

---

## 📚 Documentation Overview

This directory contains complete documentation for the authentication system.

### Primary Documents

#### 1. [`AUTHENTICATION_COMPLETE_GUIDE.md`](./AUTHENTICATION_COMPLETE_GUIDE.md) ⭐ **START HERE**

**Master reference document** - Complete implementation guide covering:
- Customer Registration (3 cases: new, existing, legacy)
- Email/Password Login (custom + Medusa gold standard)
- Password Reset Flow (scrypt-kdf gold standard)
- Google OAuth Integration
- Complete API Reference
- Frontend Integration Examples
- Testing & Troubleshooting

**Best for**: Implementation from scratch, complete reference

---

#### 2. [`AUTHENTICATION_BACKEND_API_SPEC.md`](./AUTHENTICATION_BACKEND_API_SPEC.md)

**Technical API specification** - Detailed API reference:
- All endpoint specifications
- Request/response examples
- Implementation code snippets
- Database schema details
- scrypt-kdf password hashing
- Error handling
- Testing procedures

**Best for**: API reference, backend implementation details

---

#### 3. [`CUSTOMER_AUTH_3_CASES_COMPLETE_GUIDE.md`](./CUSTOMER_AUTH_3_CASES_COMPLETE_GUIDE.md)

**Spanish comprehensive guide** - Documentación completa en español:
- Sistema de autenticación detallado
- Casos de uso con ejemplos
- Integración frontend
- Configuración del sistema
- Documentación técnica completa

**Best for**: Spanish-speaking developers, detailed technical reference

---

---

### Supporting Documents

#### [`AUTHENTICATION_VERIFICATION_WALKTHROUGH.md`](./AUTHENTICATION_VERIFICATION_WALKTHROUGH.md) 🎯 **VERIFIED**

**Complete verification walkthrough** - Production-ready proof:
- End-to-end testing results with screenshots
- Case 3 (Legacy Activation) verification
- Password Reset flow verification  
- Login verification with new password
- Technical implementation details
- Performance metrics
- Production readiness checklist

**Best for**: Verifying system works, production deployment confidence

---

#### [`GOOGLE_OAUTH_SETUP.md`](./GOOGLE_OAUTH_SETUP.md)

Google OAuth integration guide:
- Google Cloud Console configuration
- OAuth flow implementation
- Frontend integration
- Testing procedures

---

#### [`FRONTEND_CUSTOMER_API_GUIDE.md`](./FRONTEND_CUSTOMER_API_GUIDE.md)

Frontend integration patterns:
- API calling conventions
- Error handling
- State management
- Example components

---

## 🚀 Quick Start

### For New Developers

1. **Start here**: [`AUTHENTICATION_COMPLETE_GUIDE.md`](./AUTHENTICATION_COMPLETE_GUIDE.md)
2. **API reference**: [`AUTHENTICATION_BACKEND_API_SPEC.md`](./AUTHENTICATION_BACKEND_API_SPEC.md)
3. **Frontend integration**: [`FRONTEND_CUSTOMER_API_GUIDE.md`](./FRONTEND_CUSTOMER_API_GUIDE.md)

### For Testing

1. **E2E test script**: `src/scripts/test-auth-e2e.ts`
2. **Manual testing**: See "Testing & Verification" section in main guide
3. **Test credentials**: `a.vargas@ecopowertech.com` / `TestPassword123!`

---

## 🔑 Key Implementation Files

### Backend Endpoints

| File | Purpose |
|------|---------|
| `src/api/store/auth/register/route.ts` | Registration (3 cases) |
| `src/api/store/auth/activate/route.ts` | Legacy activation |
| `src/api/store/auth/login/route.ts` | Custom login endpoint |
| `src/api/store/auth/reset-password/route.ts` | Password reset request |
| `src/api/store/auth/reset-password/confirm/route.ts` | Password reset confirm |

### Test Scripts

| File | Purpose |
|------|---------|
| `src/scripts/test-auth-e2e.ts` | Complete authentication flow test |
| `src/scripts/unregister-customer.ts` | Reset customer to legacy state |
| `src/scripts/get-activation-token.ts` | Extract activation token |

---

## 📌 Critical Implementation Notes

### Password Hashing (scrypt-kdf)

**Medusa v2 uses `scrypt-kdf`, NOT `bcrypt`**

```typescript
// ✅ CORRECT
const scrypt = (await import('scrypt-kdf')).default
const hashConfig = { logN: 15, r: 8, p: 1 }
const passwordHashBuffer = await scrypt.kdf(password, hashConfig)
const passwordHash = Buffer.from(passwordHashBuffer).toString('base64')

// Store in: provider_metadata.password
```

**Storage**: `provider_identity.provider_metadata.password` (NOT `password_hash`)  
**Format**: Base64 string (NOT JSON array)

### Authentication Flow Types

1. **Registration** → JWT token (auto-login)
2. **Activation** → JWT token (auto-login)  
3. **Password Reset** → No token (login after)
4. **Login** → JWT token

---

## 🔧 Environment Setup

```bash
# Required environment variables
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
PUBLISHABLE_API_KEY=pk_xxxxx
JWT_SECRET=xxxxx
SENDGRID_API_KEY=SG.xxxxx
SENDGRID_FROM=noreply@ecopowertech.com
STOREFRONT_URL=http://localhost:4321
```

---

## 📊 API Endpoints Summary

| Endpoint | Purpose | Auto-Login |
|----------|---------|-----------|
| `POST /store/auth/register` | Register/Login | ✅ (Cases 1,2) |
| `POST /store/auth/activate` | Activate legacy | ✅ Yes |
| `POST /store/auth/login` | Standard login | ✅ Yes |
| `POST /auth/customer/emailpass` | Gold standard login | ✅ Yes |
| `POST /store/auth/reset-password` | Request reset | ❌ No |
| `POST /store/auth/reset-password/confirm` | Confirm reset | ❌ No |

---

## ✅ Implementation Status

**🎉 PRODUCTION READY - VERIFIED 2026-02-03**

- ✅ Registration (3 cases) - Verified 2026-02-03
- ✅ Activation (Case 3) - Verified 2026-02-03  
- ✅ Password Reset - Verified 2026-02-03
- ✅ Login (custom + gold standard) - Verified 2026-02-03
- ✅ 100% Medusa v2 Gold Standard
- ✅ All flows tested with screenshots
- ✅ scrypt-kdf password hashing confirmed working
- ✅ Email delivery confirmed (SendGrid)

**Tested by**: a.vargas@ecopowertech.com  
**See**: [`AUTHENTICATION_VERIFICATION_WALKTHROUGH.md`](./AUTHENTICATION_VERIFICATION_WALKTHROUGH.md) for proof

---

## 🆘 Need Help?

1. **Troubleshooting**: See "Troubleshooting" section in [`AUTHENTICATION_COMPLETE_GUIDE.md`](./AUTHENTICATION_COMPLETE_GUIDE.md)
2. **API errors**: Check [`AUTHENTICATION_BACKEND_API_SPEC.md`](./AUTHENTICATION_BACKEND_API_SPEC.md) error handling section
3. **Password reset issues**: Verify scrypt-kdf implementation in main guide

---

## 📝 Deprecated Documents

- `authentication_walkthrough.md.deprecated` - Deleted (Feb 2026). Content consolidated into `AUTHENTICATION_COMPLETE_GUIDE.md`

---

**Maintained by**: EcoPowerTech Development Team  
**Last Verified**: 2026-02-03
