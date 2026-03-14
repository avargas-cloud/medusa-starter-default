# Wholesale Pricing Management

## Arquitectura Actual (2026-02-24)

El sistema usa **Medusa's `refreshCartItemsWorkflow`** nativo para repricing, con un
hook `setPricingContext` que inyecta el customer group context. No hay lógica manual
de precios — todo es nativo de Medusa.

---

## Flujo de Precios

### Login → Precios Wholesale
1. Frontend: `ensureCustomerAssociation()` → asocia customer al carrito
2. Frontend: `POST /store/carts/:id/reprice` **CON** auth token
3. Backend: detecta `actor_id` → `force_retail = false`
4. Backend: `refreshCartItemsWorkflow(force_refresh: true)`
5. Hook `setPricingContext`: resuelve customer groups → `{ customer_group_id: [...] }`
6. Medusa Pricing Engine: aplica precio del price list de wholesale
7. Frontend: `getCart()` (cache: no-store) → `medusaCart.set()` → UI actualiza

### Logout → Precios Retail
1. Frontend: `resetCartToRetail()` (non-blocking via navigate() soft nav)
2. **FASE 1 (0ms)**: Actualización optimista usando `compare_at_unit_price`
3. Frontend: `POST /store/carts/:id/reprice` **SIN** auth token
4. Backend: detecta sin `actor_id` → `force_retail = true`
5. Backend: `refreshCartItemsWorkflow(force_refresh: true, additional_data: { force_retail: true })`
6. Hook `setPricingContext`: detecta `force_retail = true` → retorna `{}` (retail context)
7. Medusa Pricing Engine: aplica precios base (retail) — ignora customer_id en DB
8. **FASE 2 (~2-5s)**: `getCart()` (cache: no-store) → `medusaCart.set()` → UI confirma

---

## Archivos Backend Clave

### `src/api/store/carts/[id]/reprice/route.ts`
Endpoint que dispara `refreshCartItemsWorkflow`. Detecta autenticación y pasa `force_retail`.

```typescript
const isAuthenticated = !!(req.auth_context?.actor_id);
await refreshCartItemsWorkflow(req.scope).run({
    input: {
        cart_id: cartId,
        force_refresh: true,
        additional_data: { force_retail: !isAuthenticated }
    }
});
```

### `src/workflows/hooks/set-cart-pricing-context.ts`
Registra el hook para `refreshCartItemsWorkflow` Y `addToCartWorkflow`. Resuelve
el customer group para aplicar precios wholesale correctos.

```typescript
// Retorna {} → precio retail (base price)
if (additional_data?.force_retail === true) {
    return new StepResponse({});
}

// Retorna { customer_group_id: [...] } → precios wholesale
const customer = await customerModule.retrieveCustomer(cart.customer_id, {
    relations: ["groups"]
});
return new StepResponse({ customer_group_id: groupIds });
```

---

## Scripts de Administración de Precios

### `src/scripts/checks/check-test-prices.ts`
Verifica precios actuales en el sistema (retail y wholesale).

```bash
cd backend && npx tsx src/scripts/checks/check-test-prices.ts
```

---

## Estructura de Precios

### Configuración Actual (Dynamic Pricing Activo)
- **Retail** — Precio base público (todos los usuarios anónimos / retail customers)
- **Wholesale** — Precio con descuento (clientes en el customer group "Wholesale")
  - Típicamente ~7.5-10% menos que retail
  - Aplicado vía Medusa Price Lists con regla de customer_group
  - **Excepción ESTRICTA:** Productos cuyo SKU comience con el prefijo `LEG` (Legacy) están excluidos programática y permanentemente de las listas Wholesale. No reciben descuento.

### Cómo agregar precios al price list wholesale
Desde Medusa Admin:
1. Settings → Price Lists → Wholesale Pricing
2. Add Price → seleccionar variant → ingresar precio

### Cómo verificar que un customer ve precios wholesale
1. El customer debe estar en el grupo "Wholesale" (Customers → Groups en Admin)
2. El cart debe tener `customer_id` asociado (`POST /store/carts/:id/customer`)
3. `GET /store/carts/:id` debe mostrar `unit_price` con el precio wholesale

---

## Troubleshooting

### Si wholesale customers ven precios retail en el carrito:
1. Verificar que el customer está en el grupo "Wholesale" en Medusa Admin
2. Verificar que el carrito tiene `customer_id` asociado (call `updateCartCustomer()`)
3. Verificar que el hook `setPricingContext` está registrado para `refreshCartItemsWorkflow`
4. Verificar que el price list tiene regla de customer_group
5. Revisar logs del backend: `[PRICING-HOOK-REFRESH]`

### Si precios retail persisten DESPUÉS del logout:
1. Verificar que el frontend usa **soft navigation** (`navigate()`) no `window.location.href`
2. Con hard navigation el reprice se cancela (JS context muerto)
3. Verificar en console: `[CartStore] ✅ Retail confirmed. Prices: [...]`
4. Si no aparece, el `resetCartToRetail()` está fallando → revisar `[CartStore] resetCartToRetail failed`

### Si precios wholesale persisten DESPUÉS del logout:
El hook `setPricingContext` tiene `force_retail: true` path que retorna contexto vacío.
Verificar logs del backend: `[PRICING-HOOK-REFRESH] 🏷️ force_retail=true — applying retail prices`

---

## Entorno

| Variable | Backend | Frontend |
|----------|---------|----------|
| `ENABLE_DYNAMIC_PRICING` | `.env` → controla si el hook actua | — |
| `PUBLIC_ENABLE_DYNAMIC_PRICING` | — | `frontend/.env` → controla repricing en UI |

> [!NOTE]
> La variable de backend `ENABLE_DYNAMIC_PRICING` controla si el hook de precios actúa.
> La variable de frontend `PUBLIC_ENABLE_DYNAMIC_PRICING` controla si el UI dispara repricing.
> Ambas deben estar alineadas.

---

**Versión**: 2.0
**Actualizado**: 2026-02-24 — Migración a `refreshCartItemsWorkflow` nativo + `force_retail` flag + soft navigation logout
