---
**Purpose:** Guide for configuring customer-specific pricing (Wholesale vs. Retail) using Medusa v2 Admin Panel price lists, including setup steps, price list creation, and customer group assignment.

**Solves:** Medusa v2 doesn't surface price list setup intuitively — this doc maps the exact menu navigation, form fields, and customer group linking needed to activate tiered pricing for specific customers.

**Expected Result:** A store admin can create a Wholesale price list, assign products with custom prices, and link specific customer groups so those customers see wholesale prices automatically on checkout.

---

# Admin Panel Setup Guide - Customer-Specific Pricing

## 🎯 Overview

This guide walks you through setting up **customer-specific pricing** (Wholesale vs Retail) in the Medusa Admin Panel.

---

## Step 1: Create Customer Groups

### 1.1 Navigate to Customer Groups

1. Open Medusa Admin: `http://localhost:7001`
2. Go to **Customers** → **Groups**
3. Click **"Create Group"**

### 1.2 Create "Wholesale" Group

- **Name**: `Wholesale`
- **Description**: `Wholesale customers with discounted pricing`
- Click **Save**

### 1.3 (Optional) Create "Retail" Group

- **Name**: `Retail` 
- **Description**: `Regular retail customers`
- Click **Save**

> [!NOTE]
> The "Retail" group is optional. Customers without groups automatically get default pricing.

---

## Step 2: Create Price Lists

### 2.1 Navigate to Price Lists

1. Go to **Pricing** → **Price Lists**
2. Click **"Create Price List"**

### 2.2 Create Wholesale Price List

**General Information:**
- **Name**: `Wholesale Pricing`
- **Description**: `25% discount for wholesale customers`
- **Type**: `Override` (replaces default prices)
- **Status**: `Active`

**Rules Configuration:**
1. Click **"Add Rule"**
2. Select **Customer Group**
3. Choose **"Wholesale"** from dropdown
4. Click **Save Rule**

**Add Prices:**
1. Click **"Add Prices"**
2. Search for your products
3. For each variant, set the wholesale price:
   - **Example**: Retail $60.99 → Wholesale $45.99 (25% off)
4. Click **Save**

**Dates (Optional):**
- Leave empty for always-active pricing
- Or set start/end dates for seasonal pricing

Click **Save Price List**

---

## Step 3: Assign Customers to Groups

### 3.1 Create Test Customers

**Retail Customer (for testing):**
1. Go to **Customers** → **Create Customer**
2. Email: `retail@test.com`
3. Name: `Retail Test`
4. **Do NOT** assign to any group (default pricing)
5. Set password: `test123`

**Wholesale Customer:**
1. Go to **Customers** → **Create Customer**
2. Email: `wholesale@test.com`
3. Name: `Wholesale Test`
4. **Customer Groups**: Select **"Wholesale"**
5. Set password: `test123`

---

## Step 4: Verify Price List Configuration

### 4.1 Check Price List Details

1. Go back to **Pricing** → **Price Lists**
2. Click on **"Wholesale Pricing"**
3. Verify:
   - ✅ Status is **Active**
   - ✅ Rule shows **Customer Group: Wholesale**
   - ✅ Prices are configured for your products

### 4.2 Test in Admin

1. Go to any product with wholesale pricing
2. Check variants show multiple prices:
   - Default price (retail)
   - Wholesale price (in price list)

---

## Example Configuration

**Product**: UL FREECUT COB LED Strip

| Variant SKU | Default Price (Retail) | Wholesale Price (in List) | Discount |
|-------------|------------------------|---------------------------|----------|
| FCOB-12V-W | $60.99 | $45.99 | 25% |
| FCOB-12V-R | $60.99 | $45.99 | 25% |
| FCOB-24V-W | $65.99 | $49.49 | 25% |

---

## ✅ Verification Checklist

- [ ] Customer Group "Wholesale" created
- [ ] Price List "Wholesale Pricing" created with Type=Override
- [ ] Price List has rule: Customer Group = Wholesale
- [ ] Prices added to price list for test products
- [ ] Price List status is Active
- [ ] Test customer `wholesale@test.com` assigned to Wholesale group
- [ ] Test customer `retail@test.com` exists without groups

---

## Next Steps

After completing this setup, you can test the pricing in the storefront:

1. **Anonymous User**: Should see $60.99 (default)
2. **Login as `retail@test.com`**: Should see $60.99 (no group = default)
3. **Login as `wholesale@test.com`**: Should see $45.99 (wholesale price!)

See testing guide in [`CHECKOUT_PAYMENT_IMPLEMENTATION_GUIDE.md`](./CHECKOUT_PAYMENT_IMPLEMENTATION_GUIDE.md#part-8-wholesale-pricing-in-cart-critical-for-b2b)
