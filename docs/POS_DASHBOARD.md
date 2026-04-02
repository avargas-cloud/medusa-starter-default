# POS Dashboard — Panel Principal
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El Dashboard es la pantalla de inicio del POS después del login. Muestra un resumen del período seleccionado y acceso rápido a las funciones principales.

---

## Arquitectura

```
/dashboard (POS)
    ├── Quick Actions → links de navegación
    ├── Métricas del día → GET /admin/orders (filtrado client-side)
    └── Top Products → GET /admin/dashboard/top-products?from=ISO&to=ISO
                       (SQL aggregation en PostgreSQL — directo a BD)
```

---

## Acciones Rápidas

| Botón | Destino | Descripción |
|-------|---------|-------------|
| New Sale | `/orders/new` | Iniciar venta rápida (Sales Receipt) |
| New Estimate | `/estimates/new` | Crear cotización para cliente |
| Receive Payment | `/capture-payment` | Recibir pago de cliente B2B |
| Customers | `/customers` | Buscar y gestionar clientes |
| Inventory | `/inventory` | Consultar niveles de stock |

---

## Métricas

| Métrica | Fuente | Descripción |
|---------|--------|-------------|
| Total Vendido Hoy | Medusa orders | Suma de órdenes completadas del período |
| Órdenes Abiertas | Medusa orders | Órdenes `payment_status: not_paid` activas |
| Clientes Nuevos | Medusa customers | Creados en las últimas 24h |
| Top Products | `GET /admin/dashboard/top-products` | Productos más vendidos (SQL aggregation) |

---

## Navegación Principal

```
Sidebar / Top Nav:
│
├── Dashboard
├── Estimates
├── Orders
├── Invoices
├── Capture Payment
├── Customers
├── Inventory
├── Vendors
├── Accounting     (Payments, Transactions)
├── Templates
├── Users          (solo visible si isPosStaff === false)
└── Sign Out
```

---

## API / Interfaces

### `GET /admin/dashboard/top-products`

```
Query params: from (ISO 8601), to (ISO 8601)
Respuesta: top-selling products aggregated en PostgreSQL

Ejemplo:
GET /admin/dashboard/top-products?from=2026-04-01T00:00:00Z&to=2026-04-02T00:00:00Z
```

El endpoint ejecuta SQL directo en PostgreSQL para performance — reemplaza el enfoque anterior de fetchear todas las órdenes y agregar en el frontend.

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| API | `backend/src/api/admin/dashboard/top-products/route.ts` | SQL aggregation de top products |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Métricas no se actualizan | Refetch manual o recargar la página (no hay auto-refresh en tiempo real) |
| Top Products vacío | Verificar que los params `from` y `to` son ISO 8601 válidos |
| Alertas de bajo stock no visibles | Funcionalidad pendiente — requiere query de `inventory_levels` con umbral configurable |
