---
**Purpose:** Overview and navigation entry point for the 3-case customer authentication system documentation — maps each doc to its specific role and provides the recommended reading order for new developers.

**Solves:** The `backend/docs/` directory contains multiple auth-related documents, and it's unclear which to read first. This README serves as the starting point for the auth subdirectory.

**Expected Result:** Any developer landing in this documentation directory can orient themselves immediately and navigate to the right document for their task.

---

# Customer Authentication Documentation

This directory contains complete documentation for the 3-case customer authentication system.

## Documentation Files

### For Frontend Developers
**[`frontend_integration_guide.md`](./frontend_integration_guide.md)**
- Complete API contracts for all 3 cases
- Code examples ready to use (Astro/React)
- Form handlers and activation page implementation
- Testing guide and troubleshooting
- **Start here if you're integrating the frontend**

### For Backend Developers
**[`backend_api_spec.md`](./backend_api_spec.md)**
- Technical architecture and design decisions
- Database schemas and relationships
- Endpoint specifications with implementation details
- Password hashing and security considerations
- Testing scripts and production checklist
- **Start here if you're maintaining the backend**

### Implementation Walkthrough
**[`authentication_walkthrough.md`](./authentication_walkthrough.md)**
- Complete implementation story
- What was built and how it was tested
- Testing results with examples
- Key technical decisions and solutions
- **Start here for understanding the complete system**

## Quick Start

### Backend (Already Implemented ✅)
The backend is fully functional with 3 authentication cases:
1. **New customers** → Auto-login
2. **Existing customers** → Password verification + Auto-login
3. **Legacy customers** → Email activation + Auto-login

### Frontend Integration
Follow [`frontend_integration_guide.md`](./frontend_integration_guide.md):
1. Update registration form to handle `needs_activation` response
2. Create `/activate-account` page
3. Store JWT tokens from responses
4. Test all 3 cases

## API Endpoints

- **`POST /store/auth/register`** - Main registration endpoint (handles all 3 cases)
- **`POST /store/auth/activate`** - Email activation endpoint (Case 3 only)

See [`backend_api_spec.md`](./backend_api_spec.md) for complete API documentation.

## Testing

### Reset Test Customer
```bash
npx tsx src/scripts/unregister-customer.ts
```

### Test Activation Flow
```bash
# 1. Register legacy customer
curl -X POST http://localhost:9000/store/auth/register \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: pk_..." \
  -d '{"email": "test@example.com", "password": "Test123!"}'

# 2. Get activation token
npx tsx src/scripts/get-activation-token.ts

# 3. Activate with token
curl -X POST http://localhost:9000/store/auth/activate \
  -H "Content-Type: application/json" \
  -d '{"token": "TOKEN_FROM_STEP_2"}'
```

## Support

- Backend implementation: See `src/api/store/auth/`
- Testing scripts: See `src/scripts/`
- Environment config: See `.env` and `medusa-config.ts`

---

**Last Updated**: 2026-02-02  
**Status**: ✅ All 3 cases implemented and tested
