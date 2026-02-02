# Frontend Integration Guide - Customer Authentication

## 🎯 Overview

This guide provides complete instructions for integrating the customer authentication backend (3 cases) with the Astro/React frontend.

---

## API Endpoints

### Base Configuration
```typescript
const API_BASE = 'http://localhost:9000'
const API_KEY = 'pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3'
```

### 1. Registration Endpoint
**URL**: `POST /store/auth/register`

**Headers**:
```typescript
{
  'Content-Type': 'application/json',
  'x-publishable-api-key': API_KEY
}
```

**Request Body**:
```typescript
{
  email: string
  password: string
  first_name?: string
  last_name?: string
}
```

**Responses**:

#### Case 1: New Customer (Success)
```typescript
{
  success: true
  customer: {
    id: string
    email: string
    first_name: string
    last_name: string
  }
  token: string  // JWT token - store this!
}
```

#### Case 2: Existing Customer (Auto-Login Success)
```typescript
{
  success: true
  auto_logged_in: true
  customer: {
    id: string
    email: string
    first_name: string
    last_name: string
  }
  token: string  // JWT token - store this!
}
```

#### Case 2: Existing Customer (Wrong Password)
```typescript
{
  error: "Wrong password"
  message: "An account already exists with this email. Please login with your password."
}
```
**HTTP Status**: 409

#### Case 3: Legacy Customer (Needs Activation)
```typescript
{
  success: true
  needs_activation: true
  message: "Activation email sent. Please check your inbox."
}
```
**Note**: NO `token` field - activation required via email

---

### 2. Activation Endpoint
**URL**: `POST /store/auth/activate`

**Headers**:
```typescript
{
  'Content-Type': 'application/json',
  'x-publishable-api-key': API_KEY
}
```

**Request Body**:
```typescript
{
  token: string  // From activation email link
}
```

**Success Response**:
```typescript
{
  success: true
  customer: {
    id: string
    email: string
    first_name: string
    last_name: string
  }
  token: string  // JWT token - store this!
  message: "Account activated successfully. You are now logged in."
}
```

**Error Responses**:
```typescript
// Invalid/expired token
{
  error: "Invalid token" | "Token expired"
  message: string
}
```
**HTTP Status**: 400

---

## Frontend Implementation

### Registration Form Handler

```typescript
async function handleRegister(formData: {
  email: string
  password: string
  first_name?: string
  last_name?: string
}) {
  try {
    const response = await fetch(`${API_BASE}/store/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': API_KEY
      },
      body: JSON.stringify(formData)
    })

    const data = await response.json()

    // Case 3: Legacy customer - needs activation
    if (data.needs_activation) {
      showSuccessMessage(
        'Activation Email Sent',
        'Please check your email and click the activation link to complete your registration.'
      )
      // DO NOT redirect or attempt login
      // Keep user on current page or show confirmation screen
      return
    }

    // Case 1 or Case 2: Auto-login with token
    if (data.token) {
      // Store token
      localStorage.setItem('auth_token', data.token)
      
      // Store customer data (optional)
      localStorage.setItem('customer', JSON.stringify(data.customer))
      
      // Show success message
      showSuccessMessage(
        'Welcome back!',
        data.auto_logged_in 
          ? 'You have been logged in automatically.'
          : 'Your account has been created successfully.'
      )
      
      // Redirect to dashboard/account
      window.location.href = '/my-account'
      return
    }

    // Case 2: Wrong password (409 error)
    if (response.status === 409) {
      showErrorMessage(
        'Account Exists',
        data.message || 'Please use the login form with your existing password.'
      )
      return
    }

    // Unknown error
    throw new Error(data.message || 'Registration failed')

  } catch (error) {
    console.error('Registration error:', error)
    showErrorMessage(
      'Registration Failed',
      error.message || 'An unexpected error occurred. Please try again.'
    )
  }
}
```

### Activation Page Handler

Create page at `/activate-account` (or similar):

```typescript
// File: src/pages/activate-account.astro or similar

async function handleActivation() {
  // Get token from URL
  const urlParams = new URLSearchParams(window.location.search)
  const token = urlParams.get('token')

  if (!token) {
    showErrorMessage('Invalid Link', 'This activation link is invalid.')
    return
  }

  try {
    const response = await fetch(`${API_BASE}/store/auth/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': API_KEY
      },
      body: JSON.stringify({ token })
    })

    const data = await response.json()

    if (data.success && data.token) {
      // Store token
      localStorage.setItem('auth_token', data.token)
      
      // Store customer data
      localStorage.setItem('customer', JSON.stringify(data.customer))
      
      // Show success
      showSuccessMessage(
        'Account Activated!',
        'Your account has been activated successfully. Redirecting...'
      )
      
      // Redirect to dashboard
      setTimeout(() => {
        window.location.href = '/my-account'
      }, 2000)
    } else {
      // Activation failed
      showErrorMessage(
        'Activation Failed',
        data.message || 'Unable to activate your account. Please try registering again.'
      )
    }

  } catch (error) {
    console.error('Activation error:', error)
    showErrorMessage(
      'Activation Error',
      'An unexpected error occurred. Please try again or contact support.'
    )
  }
}

// Auto-run on page load
document.addEventListener('DOMContentLoaded', handleActivation)
```

---

## Complete Example: Astro Component

```astro
---
// File: src/components/RegistrationForm.astro
---

<div class="registration-form">
  <h2>Create Account</h2>
  
  <form id="registrationForm">
    <input 
      type="email" 
      name="email" 
      placeholder="Email" 
      required 
    />
    <input 
      type="password" 
      name="password" 
      placeholder="Password" 
      required 
      minlength="8"
    />
    <input 
      type="text" 
      name="first_name" 
      placeholder="First Name" 
    />
    <input 
      type="text" 
      name="last_name" 
      placeholder="Last Name" 
    />
    
    <button type="submit">Register</button>
  </form>

  <div id="message" class="message hidden"></div>
</div>

<script>
  const API_BASE = 'http://localhost:9000'
  const API_KEY = 'pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3'

  const form = document.getElementById('registrationForm')
  const messageDiv = document.getElementById('message')

  function showMessage(text: string, type: 'success' | 'error') {
    messageDiv.textContent = text
    messageDiv.className = `message ${type}`
    messageDiv.classList.remove('hidden')
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault()
    
    const formData = new FormData(e.target as HTMLFormElement)
    const data = {
      email: formData.get('email') as string,
      password: formData.get('password') as string,
      first_name: formData.get('first_name') as string,
      last_name: formData.get('last_name') as string
    }

    try {
      const response = await fetch(`${API_BASE}/store/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-publishable-api-key': API_KEY
        },
        body: JSON.stringify(data)
      })

      const result = await response.json()

      // Case 3: Activation needed
      if (result.needs_activation) {
        showMessage(
          '✅ Check your email! We sent you an activation link.',
          'success'
        )
        return
      }

      // Case 1 & 2: Auto-login
      if (result.token) {
        localStorage.setItem('auth_token', result.token)
        localStorage.setItem('customer', JSON.stringify(result.customer))
        
        showMessage('✅ Success! Redirecting...', 'success')
        setTimeout(() => {
          window.location.href = '/my-account'
        }, 1500)
        return
      }

      // Case 2: Wrong password
      if (response.status === 409) {
        showMessage(
          '❌ ' + (result.message || 'Account exists. Please login.'),
          'error'
        )
        return
      }

      throw new Error(result.message || 'Registration failed')

    } catch (error) {
      console.error('Error:', error)
      showMessage('❌ ' + error.message, 'error')
    }
  })
</script>

<style>
  .message {
    padding: 12px;
    margin-top: 16px;
    border-radius: 4px;
  }
  .message.success {
    background: #d4edda;
    color: #155724;
  }
  .message.error {
    background: #f8d7da;
    color: #721c24;
  }
  .message.hidden {
    display: none;
  }
</style>
```

---

## Authentication State Management

### Storing the Token
```typescript
// After successful login/registration/activation
localStorage.setItem('auth_token', data.token)
```

### Using the Token in API Requests
```typescript
const token = localStorage.getItem('auth_token')

fetch(`${API_BASE}/store/customers/me`, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-publishable-api-key': API_KEY
  }
})
```

### Checking if User is Logged In
```typescript
function isAuthenticated(): boolean {
  return !!localStorage.getItem('auth_token')
}
```

### Logout
```typescript
function logout() {
  localStorage.removeItem('auth_token')
  localStorage.removeItem('customer')
  window.location.href = '/login'
}
```

---

## Email Template (Activation Email)

The backend sends this email via SendGrid for **Case 3** (legacy customers):

**Subject**: Activate Your EcoPowerTech Account

**Body**:
```
Hi there!

Welcome to EcoPowerTech! Please activate your account by clicking the link below:

[Activation Link]
http://localhost:4321/activate-account?token=Y3VzX2xlZ2FjeV8uLi4

This link will expire in 24 hours.

Best regards,
The EcoPowerTech Team
```

**Frontend must handle**: `/activate-account?token=XXX`

---

## Testing Guide

### Test Case 1: New Customer
```bash
# Input
email: newuser@test.com
password: Test123!

# Expected Flow
1. Form submit → Backend creates account
2. Response includes `token`
3. Frontend stores token
4. Redirect to /my-account
```

### Test Case 2: Existing Customer (Correct Password)
```bash
# Input
email: existing@test.com
password: CorrectPassword123!

# Expected Flow
1. Form submit → Backend authenticates
2. Response includes `token` + `auto_logged_in: true`
3. Frontend stores token
4. Redirect to /my-account
```

### Test Case 2: Existing Customer (Wrong Password)
```bash
# Input
email: existing@test.com
password: WrongPassword123!

# Expected Flow
1. Form submit → Backend rejects (409)
2. error.message shown to user
3. NO redirect, stay on form
```

### Test Case 3: Legacy Customer
```bash
# Input
email: a.vargas@ecopowertech.com  # Known legacy customer
password: NewPassword123!

# Expected Flow
1. Form submit → Backend sends email
2. Response: `needs_activation: true`, NO token
3. Show "Check  your email" message
4. User clicks email link → /activate-account?token=XXX
5. Activation endpoint called
6. Response includes `token`
7. Frontend stores token
8. Redirect to /my-account
```

---

## Troubleshooting

### Issue: "Session Expired" after Case 3 registration

**Problem**: Frontend redirects to `/my-account` without token

**Solution**: Check for `needs_activation` in response BEFORE checking for `token`:
```typescript
// CORRECT ORDER ✅
if (data.needs_activation) {
  // Show email message
} else if (data.token) {
  // Auto-login
}

// WRONG ORDER ❌
if (data.token) {  // This will be undefined for Case 3
  // Auto-login - fails
}
```

### Issue: Activation link not working

**Checklist**:
1. ✅ Activation page exists at `/activate-account`
2. ✅ URL parameter `token` is being read
3. ✅ POST request to `/store/auth/activate` with token in body
4. ✅ Token stored after successful response

### Issue: 401 Unauthorized on protected routes

**Solution**: Ensure token is sent with requests:
```typescript
headers: {
  'Authorization': `Bearer ${localStorage.getItem('auth_token')}`,
  'x-publishable-api-key': API_KEY
}
```

---

## Summary Checklist

### Registration Form
- [ ] Handles `needs_activation` response (Case 3)
- [ ] Stores `token` from response (Case 1 & 2)
- [ ] Shows activation message for Case 3 (NO redirect)
- [ ] Redirects to `/my-account` only when token exists
- [ ] Shows error for wrong password (409)

### Activation Page
- [ ] Created at `/activate-account`
- [ ] Reads `token` from URL query parameter
- [ ] POSTs to `/store/auth/activate`
- [ ] Stores returned token
- [ ] Redirects to `/my-account` after success

### Authentication State
- [ ] Token stored in `localStorage`
- [ ] Token sent with protected API requests
- [ ] Logout clears token

---

## API Contract Summary

| Endpoint | Case | Response | Has Token? | Frontend Action |
|----------|------|----------|------------|----------------|
| `/store/auth/register` | 1: New | `{success, customer, token}` | ✅ Yes | Store token → Redirect |
| `/store/auth/register` | 2: Existing (correct pwd) | `{success, auto_logged_in, customer, token}` | ✅ Yes | Store token → Redirect |
| `/store/auth/register` | 2: Existing (wrong pwd) | `{error, message}` (409) | ❌ No | Show error → Stay |
| `/store/auth/register` | 3: Legacy | `{success, needs_activation, message}` | ❌ No | Show email msg → Stay |
| `/store/auth/activate` | 3: Activation | `{success, customer, token, message}` | ✅ Yes | Store token → Redirect |

**Key Rule**: Only redirect to `/my-account` when `token` exists in response!

---

## Contact

For backend issues or questions, contact the backend team or check:
- [`walkthrough.md`](file:///home/alejo/.gemini/antigravity/brain/541f0abc-3d8a-4843-ac0c-fe439e50d567/walkthrough.md) - Complete backend implementation details
- Medusa backend running on `http://localhost:9000`
