---
**Purpose:** Frontend developer guide for all customer account API endpoints in Medusa v2 — covering profile retrieval, address management, order history, and authenticated request patterns for the Astro storefront.

**Solves:** Medusa v2's customer API routes and authentication header requirements differ significantly from v1. This guide documents the exact fetch patterns, JWT header usage, and response shapes for each customer-related endpoint.

**Expected Result:** Frontend developers can implement any customer account feature (profile edit, address book, order history) using the patterns in this guide without needing to reverse-engineer the Medusa API or the backend implementation.

---

# 🔐 Customer Account API Guide - Frontend Integration

> **Version**: Medusa v2  
> **Last Updated**: 2026-02-03  
> **Audience**: Frontend Developers (Astro/React)

---

## 📋 Table of Contents

1. [Authentication Setup](#authentication-setup)
2. [My Account - Profile Overview](#1-my-account---profile-overview)
3. [My Account - Orders](#2-my-account---orders)
4. [My Account - Addresses](#3-my-account---addresses)
5. [My Account - Edit Account](#4-my-account---edit-account)
6. [Common Patterns](#common-patterns)
7. [Error Handling](#error-handling)

---

## 🔑 Authentication

**All customer account endpoints require authentication.** 

> **Note**: Authentication (login, registration, password reset) is handled separately. This guide assumes you already have an authenticated customer with a valid JWT access token.

### Required Headers

```typescript
const headers = {
  'Content-Type': 'application/json',
  'x-publishable-api-key': process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
  'Authorization': `Bearer ${customerAccessToken}` // JWT token from your auth system
}
```

---

## 1. My Account - Profile Overview

**Page**: `/my-account`

### Endpoint

```http
GET /store/customers/me
```

### Request Example

```typescript
const response = await fetch('http://localhost:9000/store/customers/me', {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
    'x-publishable-api-key': process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
    'Authorization': `Bearer ${accessToken}`
  }
});

const data = await response.json();
```

### Response Structure

```typescript
{
  "customer": {
    "id": "cus_01JKRT8...",
    "email": "john.doe@example.com",
    "first_name": "John",
    "last_name": "Doe",
    "company_name": "EcoPowerTech LLC",
    "phone": "+1 (555) 123-4567",
    "has_account": true,
    "metadata": {},
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-02-01T14:20:00Z",
    
    // Addresses array
    "addresses": [
      {
        "id": "addr_01JKRT9...",
        "customer_id": "cus_01JKRT8...",
        "company": "EcoPowerTech LLC",
        "first_name": "John",
        "last_name": "Doe",
        "address_1": "123 Main Street",
        "address_2": "Suite 400",
        "city": "Miami",
        "province": "FL",
        "postal_code": "33101",
        "country_code": "us",
        "phone": "+1 (555) 123-4567",
        "metadata": {
          "is_default_billing": true,
          "is_default_shipping": true
        },
        "created_at": "2024-01-15T10:35:00Z",
        "updated_at": "2024-01-15T10:35:00Z"
      },
      {
        "id": "addr_01JKRTB...",
        "customer_id": "cus_01JKRT8...",
        "company": null,
        "first_name": "John",
        "last_name": "Doe",
        "address_1": "456 Office Blvd",
        "address_2": null,
        "city": "Fort Lauderdale",
        "province": "FL",
        "postal_code": "33301",
        "country_code": "us",
        "phone": "+1 (555) 987-6543",
        "metadata": {
          "is_default_billing": false,
          "is_default_shipping": false
        },
        "created_at": "2024-01-20T09:15:00Z",
        "updated_at": "2024-01-20T09:15:00Z"
      }
    ]
  }
}
```

### Data Mapping for Profile Page

```typescript
// Profile Information
const profileData = {
  firstName: customer.first_name,
  lastName: customer.last_name,
  companyName: customer.company_name || 'N/A',
  phone: customer.phone || 'Not provided',
  email: customer.email,
};

// Default Billing Address
const defaultBillingAddress = customer.addresses.find(
  addr => addr.metadata?.is_default_billing === true
);

// Default Shipping Address
const defaultShippingAddress = customer.addresses.find(
  addr => addr.metadata?.is_default_shipping === true
);

// Helper to format address
function formatAddress(address) {
  if (!address) return 'No default address set';
  
  return `
    ${address.first_name} ${address.last_name}
    ${address.company ? address.company + '\n' : ''}
    ${address.address_1}
    ${address.address_2 ? address.address_2 + '\n' : ''}
    ${address.city}, ${address.province} ${address.postal_code}
    ${address.country_code.toUpperCase()}
  `.trim();
}
```

### UI Display Example

```typescript
<div className="profile-overview">
  <h2>Account Information</h2>
  <p><strong>Name:</strong> {profileData.firstName} {profileData.lastName}</p>
  <p><strong>Company:</strong> {profileData.companyName}</p>
  <p><strong>Email:</strong> {profileData.email}</p>
  <p><strong>Phone:</strong> {profileData.phone}</p>
  
  <h3>Default Billing Address</h3>
  <pre>{formatAddress(defaultBillingAddress)}</pre>
  
  <h3>Default Shipping Address</h3>
  <pre>{formatAddress(defaultShippingAddress)}</pre>
</div>
```

---

## 2. My Account - Orders

**Page**: `/my-account/orders`

### Endpoint

```http
GET /store/customers/me/orders
```

### Query Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `limit` | number | Number of orders per page | 10 |
| `offset` | number | Pagination offset | 0 |
| `fields` | string | Comma-separated fields to include | all |
| `order` | string | Sort order | `-created_at` |

### Request Example

```typescript
const params = new URLSearchParams({
  limit: '10',
  offset: '0',
  order: '-created_at' // Most recent first
});

const response = await fetch(
  `http://localhost:9000/store/customers/me/orders?${params}`,
  {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
      'Authorization': `Bearer ${accessToken}`
    }
  }
);

const data = await response.json();
```

### Response Structure

```typescript
{
  "orders": [
    {
      "id": "order_01JKRTC...",
      "status": "pending",
      "fulfillment_status": "not_fulfilled",
      "payment_status": "awaiting",
      "display_id": 1001,
      "customer_id": "cus_01JKRT8...",
      "email": "john.doe@example.com",
      "currency_code": "usd",
      "total": 15999, // Cents
      "subtotal": 14999,
      "tax_total": 1000,
      "shipping_total": 0,
      "created_at": "2024-02-01T10:30:00Z",
      "updated_at": "2024-02-01T10:30:00Z",
      
      "items": [
        {
          "id": "li_01JKRTD...",
          "title": "LED Strip 5050 RGB - 5m",
          "quantity": 2,
          "unit_price": 7499,
          "total": 14998,
          "thumbnail": "https://cdn.example.com/led-strip.jpg",
          "variant": {
            "id": "variant_01JKRTE...",
            "title": "5 meters / RGB",
            "sku": "LED-5050-RGB-5M"
          }
        }
      ],
      
      "shipping_address": {
        "first_name": "John",
        "last_name": "Doe",
        "address_1": "123 Main Street",
        "city": "Miami",
        "province": "FL",
        "postal_code": "33101",
        "country_code": "us"
      }
    }
  ],
  "count": 25,
  "limit": 10,
  "offset": 0
}
```

### Data Mapping for Orders Page

```typescript
interface OrderListItem {
  id: string;
  orderNumber: number;
  date: string;
  status: string;
  total: string;
  itemCount: number;
}

function mapOrdersForDisplay(orders): OrderListItem[] {
  return orders.map(order => ({
    id: order.id,
    orderNumber: order.display_id,
    date: new Date(order.created_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }),
    status: formatOrderStatus(order.status, order.fulfillment_status, order.payment_status),
    total: formatCurrency(order.total, order.currency_code),
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0)
  }));
}

function formatOrderStatus(status, fulfillment, payment) {
  if (payment === 'captured' && fulfillment === 'fulfilled') {
    return 'Completed';
  }
  if (fulfillment === 'shipped') {
    return 'Shipped';
  }
  if (payment === 'awaiting') {
    return 'Pending Payment';
  }
  return 'Processing';
}

function formatCurrency(amountInCents, currencyCode) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode.toUpperCase()
  }).format(amountInCents / 100);
}
```

---

## 3. My Account - Addresses

**Page**: `/my-account/addresses`

### Endpoint

```http
GET /store/customers/me
```

> **Note**: Use the same endpoint as profile. The `addresses` array contains all address information.

### Understanding Address Default Flags

Each address has `metadata` field with two possible flags:

```typescript
{
  "metadata": {
    "is_default_billing": boolean,  // Is this the default billing address?
    "is_default_shipping": boolean  // Is this the default shipping address?
  }
}
```

### Possible Scenarios

| Scenario | `is_default_billing` | `is_default_shipping` | Description |
|----------|---------------------|----------------------|-------------|
| **Same for both** | `true` | `true` | This address is used for both billing and shipping by default |
| **Billing only** | `true` | `false` | Default billing address, but not for shipping |
| **Shipping only** | `false` | `true` | Default shipping address, but not for billing |
| **Neither** | `false` | `false` | Regular address, not set as default for either |

### Data Mapping for Addresses Page

```typescript
interface AddressDisplay {
  id: string;
  fullName: string;
  company?: string;
  fullAddress: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  phone?: string;
  isDefaultBilling: boolean;
  isDefaultShipping: boolean;
  badges: string[]; // ['Default Billing', 'Default Shipping']
}

function mapAddressesForDisplay(addresses): AddressDisplay[] {
  return addresses.map(addr => {
    const badges = [];
    if (addr.metadata?.is_default_billing) {
      badges.push('Default Billing');
    }
    if (addr.metadata?.is_default_shipping) {
      badges.push('Default Shipping');
    }
    
    return {
      id: addr.id,
      fullName: `${addr.first_name} ${addr.last_name}`,
      company: addr.company,
      fullAddress: `${addr.address_1}${addr.address_2 ? ', ' + addr.address_2 : ''}`,
      city: addr.city,
      province: addr.province,
      postalCode: addr.postal_code,
      country: addr.country_code.toUpperCase(),
      phone: addr.phone,
      isDefaultBilling: addr.metadata?.is_default_billing || false,
      isDefaultShipping: addr.metadata?.is_default_shipping || false,
      badges
    };
  });
}
```

### UI Display Example

```typescript
<div className="addresses-list">
  {mappedAddresses.map(address => (
    <div key={address.id} className="address-card">
      <div className="address-header">
        <h3>{address.fullName}</h3>
        <div className="badges">
          {address.badges.map(badge => (
            <span className="badge" key={badge}>{badge}</span>
          ))}
        </div>
      </div>
      
      {address.company && <p>{address.company}</p>}
      <p>{address.fullAddress}</p>
      <p>{address.city}, {address.province} {address.postalCode}</p>
      <p>{address.country}</p>
      {address.phone && <p>Phone: {address.phone}</p>}
      
      <div className="actions">
        <button onClick={() => editAddress(address.id)}>Edit</button>
        <button onClick={() => deleteAddress(address.id)}>Delete</button>
        {!address.isDefaultBilling && (
          <button onClick={() => setDefaultBilling(address.id)}>
            Set as Default Billing
          </button>
        )}
        {!address.isDefaultShipping && (
          <button onClick={() => setDefaultShipping(address.id)}>
            Set as Default Shipping
          </button>
        )}
      </div>
    </div>
  ))}
</div>
```

### Adding a New Address

```http
POST /store/customers/me/addresses
```

**Request Body:**

```typescript
{
  "first_name": "John",
  "last_name": "Doe",
  "company": "EcoPowerTech LLC", // Optional
  "address_1": "789 New Street",
  "address_2": "Floor 3", // Optional
  "city": "Orlando",
  "province": "FL",
  "postal_code": "32801",
  "country_code": "us",
  "phone": "+1 (555) 111-2222", // Optional
  "metadata": {
    "is_default_billing": false,
    "is_default_shipping": false
  }
}
```

### Updating an Address

```http
POST /store/customers/me/addresses/{address_id}
```

**Request Body:** Same as creating, but all fields are optional (only send what you want to update).

### Deleting an Address

```http
DELETE /store/customers/me/addresses/{address_id}
```

### Setting Default Addresses

To set an address as default, update its metadata:

```typescript
// Set as default shipping
await fetch(`http://localhost:9000/store/customers/me/addresses/${addressId}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-publishable-api-key': process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
    'Authorization': `Bearer ${accessToken}`
  },
  body: JSON.stringify({
    metadata: {
      is_default_shipping: true
    }
  })
});

// Important: You should also unset the previous default
// This requires finding it first and setting to false
```

> ⚠️ **Important**: Medusa doesn't automatically unset the previous default. Your frontend should:
> 1. Find the current default address
> 2. Update it to set `is_default_X: false`
> 3. Then update the new address to set `is_default_X: true`

---

## 4. My Account - Edit Account

**Page**: `/my-account/edit-account`

### Endpoint

```http
POST /store/customers/me
```

### Editable Fields

```typescript
interface CustomerUpdate {
  first_name?: string;
  last_name?: string;
  company_name?: string;
  phone?: string;
  email?: string;
  metadata?: Record<string, any>;
}
```

### Request Example

```typescript
const updates = {
  first_name: "John",
  last_name: "Smith", // Changed from Doe
  company_name: "EcoPowerTech Solutions",
  phone: "+1 (555) 999-8888"
};

const response = await fetch('http://localhost:9000/store/customers/me', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-publishable-api-key': process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
    'Authorization': `Bearer ${accessToken}`
  },
  body: JSON.stringify(updates)
});

const data = await response.json();
```

### Response

Returns the updated customer object (same structure as `GET /store/customers/me`).

> **Note**: Password changes are handled by a separate authentication system.

### Validation Rules

| Field | Rules | Example Error |
|-------|-------|---------------|
| `email` | Valid email format, unique | "Email already exists" |
| `first_name` | Required, min 1 char | "First name is required" |
| `last_name` | Required, min 1 char | "Last name is required" |
| `phone` | Optional, valid phone format | "Invalid phone number" |
| `password` | Min 8 chars, at least 1 number | "Password too weak" |

---

## 🔄 Common Patterns

### Authentication Check

```typescript
async function isAuthenticated() {
  try {
    const response = await fetch('http://localhost:9000/store/customers/me', {
      headers: {
        'x-publishable-api-key': process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    return response.ok;
  } catch {
    return false;
  }
}
```

### Loading States

```typescript
const [customer, setCustomer] = useState(null);
const [loading, setLoading] = useState(true);
const [error, setError] = useState(null);

useEffect(() => {
  async function fetchCustomer() {
    try {
      setLoading(true);
      const response = await fetch('http://localhost:9000/store/customers/me', {
        headers: {
          'x-publishable-api-key': process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${accessToken}`
        }
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch customer data');
      }
      
      const data = await response.json();
      setCustomer(data.customer);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  
  fetchCustomer();
}, []);
```

---

## ⚠️ Error Handling

### Common HTTP Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| `401` | Unauthorized - Invalid/expired token | Redirect to login |
| `403` | Forbidden - Insufficient permissions | Show error message |
| `404` | Resource not found | Show "not found" message |
| `422` | Validation error | Show field-specific errors |
| `500` | Server error | Show generic error, retry |

### Error Response Format

```typescript
{
  "type": "validation_error",
  "message": "Invalid input data",
  "errors": [
    {
      "field": "email",
      "message": "Email is already in use"
    }
  ]
}
```

### Error Handling Example

```typescript
try {
  const response = await fetch(url, options);
  
  if (!response.ok) {
    const errorData = await response.json();
    
    if (response.status === 401) {
      // Token expired or invalid
      redirectToLogin();
      return;
    }
    
    if (response.status === 422) {
      // Validation errors
      setFieldErrors(errorData.errors);
      return;
    }
    
    throw new Error(errorData.message || 'Something went wrong');
  }
  
  const data = await response.json();
  // Handle success
} catch (error) {
  console.error('Request failed:', error);
  showErrorToast(error.message);
}
```

---

## 🚀 Quick Reference

### Base URL

```typescript
const BASE_URL = process.env.NEXT_PUBLIC_MEDUSA_URL || 'http://localhost:9000';
```

### Required Environment Variables

```bash
NEXT_PUBLIC_MEDUSA_URL=http://localhost:9000
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_xxx...
```

### TypeScript Types

```typescript
interface Customer {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  company_name?: string;
  phone?: string;
  has_account: boolean;
  metadata?: Record<string, any>;
  addresses: Address[];
  created_at: string;
  updated_at: string;
}

interface Address {
  id: string;
  customer_id: string;
  company?: string;
  first_name: string;
  last_name: string;
  address_1: string;
  address_2?: string;
  city: string;
  province: string;
  postal_code: string;
  country_code: string;
  phone?: string;
  metadata?: {
    is_default_billing?: boolean;
    is_default_shipping?: boolean;
    [key: string]: any;
  };
  created_at: string;
  updated_at: string;
}
```

---

## 📞 Support

For backend API issues or questions, contact the backend team or check the Medusa v2 documentation:
- [Medusa Store API Reference](https://docs.medusajs.com/api/store)
- [Customer Management](https://docs.medusajs.com/modules/customers)

---

**Document Version**: 1.0.0  
**Medusa Version**: v2  
**Last Reviewed**: 2026-02-03
