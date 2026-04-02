# POS Vendors — Proveedores
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: 🟡 En desarrollo (UI existe, backend sin módulo dedicado)

---

## ¿Qué es y por qué existe?

El módulo Vendors gestiona los proveedores de EcoPowerTech desde el POS. Permite al staff consultar contactos de proveedores, histórico de compras y catálogos de productos por proveedor.

---

## Estado Actual

La ruta `/vendors` existe en el POS (`store-pos/app/(pos)/vendors/page.tsx`). No hay un módulo backend dedicado ni endpoints API custom para vendors — los datos de proveedor viven en `product.metadata.vendor` en Medusa.

---

## Arquitectura (Actual)

```
/vendors (POS)
    └── Datos de vendor en product.metadata
         └── No hay tabla vendor dedicada — los productos tienen metadata.vendor (string)
```

---

## Lista de Vendors (`/vendors`)

- Búsqueda por nombre, contacto, categoría de producto
- Columnas: Nombre, Contacto, Email, Teléfono, Productos activos

---

## Detalle de Vendor

| Sección | Descripción |
|---------|-------------|
| **Info** | Nombre, dirección, contacto principal, términos de pago |
| **Products** | Productos del catálogo que provee |
| **Purchase Orders** | Historial de órdenes de compra (futuro) |
| **Notes** | Notas internas del staff |

---

## Integración Futura

- **Purchase Orders**: Crear POs desde el POS y enviar al proveedor
- **Sync con QB**: Vendors en QB mapped a proveedores del POS
- **Receiving**: Registrar recepción de mercancía y ajustar inventory
- **Módulo dedicado**: Tabla `vendor` con campos completos (contact, address, terms, etc.)

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| POS | `store-pos/app/(pos)/vendors/page.tsx` | Página de lista de vendors |

---

## Pendientes

| Pendiente | Descripción |
|-----------|-------------|
| Módulo backend `vendors` | Tabla y servicio dedicado para vendors |
| QuickBooks Vendor sync | Mapear vendors de Medusa con QB Vendor ListID |
| Purchase Orders flow | No implementado — requiere nuevo módulo o extensión |
| Catálogo por vendor | Los productos deben tener `metadata.vendor_id` para filtrar correctamente |
