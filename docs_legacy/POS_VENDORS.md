# POS_VENDORS — Proveedores

| Campo | Detalle |
|-------|---------|
| **Módulo** | Vendors |
| **Ruta POS** | `/vendors` |
| **Estado** | 🟡 En desarrollo |
| **Última revisión** | 2026-03-06 |

---

## Descripción

El módulo Vendors gestiona los proveedores de EcoPowerTech. Permite al staff consultar contactos de proveedores, histórico de compras, y catálogos de productos por proveedor.

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

---

## Known Issues / Pendientes

| Pendiente | Descripción |
|-----------|-------------|
| QuickBooks Vendor sync | Mapear vendors de Medusa con QB Vendor ListID |
| Purchase Orders flow | No implementado — requiere nuevo módulo o extensión |
| Catálogo por vendor | Los productos deben tener `metadata.vendor_id` para filtrar |
