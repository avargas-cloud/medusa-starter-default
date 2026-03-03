# Draft Orders — Advanced UI

> **Ruta:** `backend/src/admin/routes/draft-orders-advanced/`  
> **Última revisión:** 2026-03-03

---

## Resumen

El sistema de Draft Orders tiene **dos vistas**:

| Vista | URL | Descripción |
|-------|-----|-------------|
| **Native Medusa** | `/app/draft-orders/[id]` | Vista estándar de Medusa v2 |
| **Advanced** | `/app/draft-orders-advanced/[id]` | Vista custom con Items inline, Taxes, Shipping, QB sync |

La vista avanzada **extiende** la native view, añadiendo controles en tiempo real sin salir de la página.

---

## Arquitectura

```
draft-orders-advanced/
├── page.tsx                    # Página principal de detalle
├── [id]/
│   ├── hooks/
│   │   ├── use-draft-order-detail.tsx   # Estado principal + CRUD de items
│   │   └── use-order-page-state.ts      # Precios de variantes + shipping options
│   └── components/
│       ├── InlineItemsTable.tsx          # Tabla de items editable
│       ├── PriceCombobox.tsx             # Dropdown de precios (Default + Wholesale)
│       ├── InlineTaxes.tsx               # Sección de taxes
│       └── InlineShipping.tsx            # Sección de shipping
```

---

## Endpoints Custom (API Backend)

### `GET /admin/draft-orders/:id/variant-prices`

Retorna todos los precios disponibles (Default + Price Lists activos) para variantes específicas.

**Query params:** `?variant_ids[]=v1&variant_ids[]=v2`

**Response:**
```json
{
  "prices": {
    "variant_01KFRNPMS8571FDJZRZ3RRMYYK": {
      "default": { "amount": 56.75, "currency_code": "usd" },
      "list": [
        {
          "amount": 51.25,
          "currency_code": "usd",
          "price_list_id": "plist_01KFTSDZZNTQRSYNMB4YST1HYA",
          "price_list_name": "Wholesale Pricing"
        }
      ]
    }
  }
}
```

**Implementación:** SQL directo via `pg.Pool`. Usa `product_variant_price_set` → `price` → `price_list` con `pl.title` (no `pl.name`).

> ⚠️ **Nota:** Los precios en Medusa v2 están en **dólares (major units)**, no en centavos. No dividir por 100.

---

### `POST /admin/draft-orders/:id/compute-tax`

Calcula y **persiste** el tax al native order view.

**Body:** `{ "tax_amount": 12.83, "tax_rate": 7.0 }`

**Comportamiento:**
1. Obtiene los `item_id` activos del order (`DISTINCT` para evitar duplicados por versiones)
2. **Hard-DELETE** de tax lines previas con `code = 'manual'`
3. Inserta una `order_line_item_tax_line` por item
4. Actualiza `order_summary.totals` JSONB con `tax_total` y recalcula `current_order_total`

**Tablas afectadas:**
- `order_line_item_tax_line`
- `order_summary` (campo `totals` JSONB)

---

## Dropdown de Precios (PriceCombobox)

El componente `PriceCombobox` aparece en la columna **Price** de cada item en `InlineItemsTable`.

### Lógica de popup
- Se muestra el botón ▾ solo si `options.length > 0`
- `options` viene de `customerPrices[item.variant_id]` (estado del hook `useOrderPageState`)
- Se divide en dos secciones: **Default** (sin `priceListId`) y **Wholesale** (con `priceListId`)

### Auto-guardado
- **3 segundos** de debounce al editar el precio manualmente
- Guardado inmediato al hacer blur (salir del campo o seleccionar otra opción)
- Indicadores visuales: `saving…` y `✓`

---

## Precio por defecto al agregar item

En `InlineItemsTable`, al hacer click en un resultado del search:
```typescript
const price = contractorP ?? defaultP  // Wholesale si existe, sino Default
handleAddItem(v.id, price?.amount)
```

- Si el cliente tiene grupo **Wholesale**, se aplica el wholesale price automáticamente
- Si no, se usa el precio Default (retail)

---

## Taxes

### Cálculo (Frontend)
El componente `InlineTaxes` calcula el tax basado en:
- Monto total de los items
- Tasa de impuesto (configurable: `auto` → 7% FL, `exempt` → 0%, `florida` → 7%)

El cálculo ocurre en el frontend y llama al endpoint `compute-tax`.

### Persistencia (Backend)
El tax se persiste en:
1. `order_line_item_tax_line` — una fila por item
2. `order_summary.totals` JSONB — `tax_total` y `current_order_total`

Esto garantiza que el **native draft order view** muestre el tax correctamente.

---

## Direcciones

### Store Pickup
Cuando se selecciona "Miami Store Pickup" como método de envío, se asigna automáticamente:

```
Company: Ecopowertech Inc
Address: 2760 W 84th St, Unit 4
City: Hialeah, FL 33016
Country: US
```

Configurado en `use-draft-order-detail.tsx` → función `handleShippingChange`.

---

## Price Lists — Configuración Actual

| Nombre | ID | Uso |
|--------|-----|-----|
| Wholesale Pricing | `plist_01KFTSDZZNTQRSYNMB4YST1HYA` | Clientes con grupo "Wholesale" |

### Customer Groups → Price Lists
Los price lists se asignan automáticamente basados en el customer group del cliente seleccionado. El endpoint `variant-prices` retorna todos los price lists activos para que el UI los muestre.

---

## Flujo Completo de Draft Order

1. **Crear** draft order → `/app/draft-orders-advanced` → botón Create
2. **Asignar cliente** → precio por defecto se establece según su grupo (Retail/Wholesale)
3. **Agregar items** → búsqueda en tiempo real, precio automático según customer
4. **Ajustar precios** → dropdown ▾ por item (Default / Wholesale), auto-save 3s
5. **Shipping** → Miami Store Pickup o UPS, precio calculado
6. **Taxes** → computar con botón en sección Taxes (tasa FL 7%)
7. **Convertir** → botón "Convert to Order" en la página native o advanced
8. **QB Sync** → botón "Save to QuickBooks" crea Estimate en QB Desktop

---

## Tablas PostgreSQL Relevantes

| Tabla | Descripción |
|-------|-------------|
| `order` | Draft orders y órdenes regulares |
| `order_item` | Enlace entre order y versiones de line items |
| `order_line_item` | Datos del item (precio, cantidad, variant_id) |
| `order_line_item_tax_line` | Tax lines por item |
| `order_summary` | Totales JSONB (subtotal, tax, total) |
| `product_variant_price_set` | Enlace variante → price set |
| `price` | Precios individuales (default y price list) |
| `price_list` | Listas de precios (Wholesale, etc.) |

---

## Bugs Conocidos / Pendientes

- [ ] **Botón Create Draft Order** — necesita revisión
- [ ] **Tax en native view** — verificar que persiste correctamente tras todos los flujos
- [ ] **Wholesale en dropdown** — verificar después del fix del 500 en `variant-prices`
- [ ] **Convertir Draft Order a Order** — flujo completo por verificar
