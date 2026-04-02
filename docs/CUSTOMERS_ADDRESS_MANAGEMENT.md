# Customers — Address Management
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

Medusa v2 no soporta nativamente el "swap" de direcciones default: al marcar una nueva direccion como default billing/shipping, no elimina el flag de la anterior, resultando en multiples defaults simultaneos.

El endpoint custom `POST /store/customers/me/addresses/:address_id` implementa el swap atomico: al marcar una nueva default, borra el flag de todas las otras automaticamente. Tambien sincroniza tanto los campos nativos de Medusa como el campo `metadata` para compatibilidad.

---

## Arquitectura

```
POST /store/customers/me/addresses/:address_id
    |
    v
Validar auth (req.auth_context.actor_id)
    |
    v
¿is_default_billing = true o is_default_shipping = true?
    |
    v Si → SWAP:
    Encontrar todas las otras direcciones del customer
    Para cada una: unset is_default_billing/shipping (nativo + metadata)
    |
    v
Actualizar direccion TARGET con todos los campos del body
    (incluyendo nativo + metadata en sync)
    |
    v
Respuesta: { success: true }
```

---

## Modelo de Datos

### Tabla customer_address

```sql
CREATE TABLE customer_address (
    id VARCHAR PRIMARY KEY,
    customer_id VARCHAR NOT NULL,
    first_name VARCHAR,
    last_name VARCHAR,
    company VARCHAR,
    address_1 VARCHAR,
    address_2 VARCHAR,
    city VARCHAR,
    province VARCHAR,
    postal_code VARCHAR,
    country_code VARCHAR,
    phone VARCHAR,

    -- Campos nativos Medusa v2
    is_default_billing BOOLEAN DEFAULT FALSE,
    is_default_shipping BOOLEAN DEFAULT FALSE,

    -- Metadata (JSONB)
    metadata JSONB,

    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    deleted_at TIMESTAMP
);
```

### Almacenamiento dual (nativo + metadata)

Cada flag se guarda en dos lugares simultaneamente:

```json
{
    "id": "addr_01ABC",
    "is_default_billing": true,           // campo nativo
    "is_default_shipping": false,
    "metadata": {
        "nickname": "Home",
        "is_default_billing": true,       // duplicado en metadata
        "is_default_shipping": false
    }
}
```

**Por que dos lugares:**
- Campos nativos: forma intencional de Medusa (future-proof)
- Metadata: compatibilidad con frontends que lean defaults desde metadata

---

## Flujo del Swap

```
Antes: Address A = default billing, Address B y C = no default

Usuario selecciona Address B como default billing

Backend:
1. Encontrar A y C (todas las otras del customer)
2. Para A: is_default_billing = false (nativo) + metadata.is_default_billing = false
3. Para C: is_default_billing = false (nativo) + metadata.is_default_billing = false
4. Para B: is_default_billing = true (nativo) + metadata.is_default_billing = true

Despues: Address B = default billing, A y C = no default
```

---

## API

### Endpoint

`POST /store/customers/me/addresses/:address_id`

**Autenticacion:** Cookie de sesion de customer (requiere `req.auth_context.actor_id`)

**Body:**
```typescript
{
    first_name: string
    last_name: string
    address_1: string
    address_2?: string
    city: string
    province: string
    postal_code: string
    country_code: string
    phone?: string
    is_default_billing: boolean
    is_default_shipping: boolean
    metadata?: Record<string, unknown>
}
```

**Respuesta exitosa:**
```json
{
    "success": true,
    "message": "Address updated successfully"
}
```

**Errores:**
```json
{ "message": "Unauthorized" }          // 401 — no autenticado
{ "success": false, "message": "..." } // 500 — error interno
```

**Campos a NO enviar** (readonly — Medusa retorna 400 "Unrecognized Fields"):
- `id`, `customer_id`, `created_at`, `updated_at`, `deleted_at`

---

## Implementacion

El endpoint esta en `src/api/store/customers/me/addresses/[address_id]/route.ts`.

Usa `updateCustomerAddressesWorkflow` de `@medusajs/medusa/core-flows` para cada update. El workflow garantiza consistencia transaccional.

**Patron critico para metadata:**
```typescript
// ✓ CORRECTO — preservar metadata existente
metadata: {
    ...(req.body.metadata || {}),          // metadata existente del body
    is_default_billing: setAsDefaultBilling,
    is_default_shipping: setAsDefaultShipping
}

// ✗ INCORRECTO — sobreescribe todo el metadata
metadata: {
    is_default_billing: setAsDefaultBilling
}
```

---

## Troubleshooting

### "Unauthorized"

`req.auth_context.actor_id` es undefined. Verificar que el request incluye un token JWT valido en el header o cookie de sesion.

### Multiples direcciones con is_default_billing = true

El swap no se ejecuto correctamente. Verificar:
```bash
SELECT id, is_default_billing, is_default_shipping
FROM customer_address
WHERE customer_id = 'cus_XXX';
```

Si hay duplicados, ejecutar manualmente:
```sql
UPDATE customer_address
SET is_default_billing = false
WHERE customer_id = 'cus_XXX' AND id != 'addr_correcto';
```

### 400 "Unrecognized Fields"

El frontend esta enviando campos readonly (`id`, `customer_id`, etc.). El frontend debe filtrar antes de enviar.

---

## Archivos Clave

| Tipo | Ruta Completa | Proposito |
|------|---------------|-----------|
| Route | `/home/alejo/webapps/ecopowertech-workspace/backend/src/api/store/customers/me/addresses/[address_id]/route.ts` | Endpoint de update con swap logic |

---

## Historial de Decisiones

- **Dual storage (nativo + metadata)**: Los campos nativos son la forma correcta en Medusa v2. El metadata duplicado es para compatibilidad con implementaciones anteriores de frontend que lean defaults desde metadata.
- **updateCustomerAddressesWorkflow en loop**: Se ejecuta un workflow separado por cada direccion a actualizar (unset + set target). Es menos eficiente que un UPDATE bulk pero garantiza rollback automatico por workflow si algo falla.
- **No usar transaction nativa de Medusa**: `req.scope.resolve("manager")` no es el patron correcto en Medusa v2. Los workflows ya tienen rollback incorporado.
