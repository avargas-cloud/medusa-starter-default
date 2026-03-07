# POS_DASHBOARD — Panel Principal

| Campo | Detalle |
|-------|---------|
| **Módulo** | Dashboard |
| **Ruta POS** | `/dashboard` |
| **Última revisión** | 2026-03-06 |

---

## Descripción

El Dashboard es la pantalla de inicio del POS después del login. Muestra un resumen del día y acceso rápido a las funciones principales.

---

## Acciones Rápidas

| Botón | Destino | Descripción |
|-------|---------|-------------|
| **New Sale** | `/orders/new` | Iniciar venta rápida (Sales Receipt) |
| **New Estimate** | `/estimates/new` | Crear cotización para cliente |
| **Receive Payment** | `/capture-payment` | Recibir pago de cliente B2B |
| **Customers** | `/customers` | Buscar y gestionar clientes |
| **Inventory** | `/inventory` | Consultar niveles de stock |

---

## Métricas del Día

| Métrica | Fuente | Descripción |
|---------|--------|-------------|
| Total Vendido Hoy | Medusa orders | Suma de órdenes completadas del día |
| Órdenes Abiertas | Medusa orders | Órdenes `payment_status: not_paid` activas |
| Clientes Nuevos | Medusa customers | Creados en las últimas 24h |
| Balance de Crédito Total | credit_ledger | Suma de créditos pendientes de todos los clientes |

---

## Navegación Principal

```
Sidebar / Top Nav:
│
├── 📊 Dashboard
├── 🧾 Estimates
├── 📦 Orders
├── 💳 Capture Payment
├── 👤 Customers
├── 📋 Inventory
├── 🏭 Vendors
├── 👥 Users          (solo visible para pos_admin)
└── 🚪 Sign Out
```

---

## Actividad Reciente

- Últimas 10 órdenes del día (link a `/orders/[id]`)
- Últimas 5 estimaciones modificadas (link a `/estimates/[id]`)
- Alertas de bajo stock (productos con stock < threshold)

---

## Known Issues / Pendientes

| Issue | Fix |
|-------|-----|
| Métricas de "hoy" no están en tiempo real | Refetch cada 60s o usar SWR con revalidation |
| Alertas de bajo stock no implementadas | Requiere query de inventory_levels con umbral configurable |
