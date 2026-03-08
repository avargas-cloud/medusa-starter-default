# POS_CUSTOMERS — Gestión de Clientes

| Campo | Detalle |
|-------|---------|
| **Módulo** | Customers |
| **Rutas POS** | `/customers`, `/customers/[id]` |
| **Última revisión** | 2026-03-07 |

---

## Descripción

El módulo de Customers permite al staff buscar, ver y gestionar clientes de EcoPowerTech. Incluye un listado avanzado potenciado por MeiliSearch, y una vista de detalles optimizada en 3 filas para resoluciones 1080p.

---

## 1. Búsqueda de Clientes (Listado `/customers`)

La página principal de clientes (`app/(pos)/customers/page.tsx`) usa un layout **No-Scroll 1080p** con un ancho máximo expansivo (`max-w-[1800px]`) para que la tabla utilice todo el ancho de la pantalla y no se trunquen datos largos.

### MeiliSearch Integración
La búsqueda usa **MeiliSearch** (`searchCustomers` en `lib/meilisearch.ts`) para resultados en tiempo real con debounce (250ms).

Para que la tabla muestre correctamente todos los datos, el plugin de Meilisearch en Medusa (`backend/medusa-config.ts`) está configurado con un **transformer personalizado** que inyecta a nivel raíz los siguientes campos:

- `customer_type` (Extraído de `metadata.qb_customer_type` o `metadata.customer_type`)
- `price_level` (Extraído del grupo "Wholesale" o de `metadata.price_level`)
- `acquisition_channel`
- `list_id` (QuickBooks ID)
- `status` ("Registered" o "Guest" basado en `has_account`)

**Configuración en MeiliSearch (`medusa-config.ts`):**
```typescript
filterableAttributes: [
  "customer_type", "price_level", "has_account", "groups", "status"
],
displayedAttributes: [
  "id", "email", "first_name", "last_name", "company_name", "phone",
  "has_account", "groups", "metadata", "created_at", "updated_at",
  "customer_type", "price_level", "acquisition_channel", "list_id", "status"
]
```

### Columnas de la Tabla (1080p Grid)
El diseño de columnas asigna proporcionalmente el ancho utilizando CSS Grid:
`Name`, `Company`, `Email`, `Phone`, `Customer Type`, `Price Level`, `Acq. Channel`, `Status`

---

## 2. Detalle de Cliente (`/customers/[id]`)

La página de detalles (`app/(pos)/customers/[id]/page.tsx`) abandonó el diseño de Tabs a favor de un layout modular de 3 filas apiladas (Stacked Cards) sin scroll global en pantalla 1080p. 

### Estructura del Layout (3 Filas)

| Fila | Componente | Descripción |
|------|------------|-------------|
| **1 (Izquierda)** | `CustomerDetailsCard` | Info básica de contacto, campos editables en modal (Company, Phone, QB List ID, Customer Type, Acquisition Channel), insignias de Status, Tipo y Nivel de Precio. |
| **1 (Derecha)**   | `CustomerAddressesCard` | Direcciones de Billing y Shipping lado a lado. Cada una tiene su propio modal de edición con validación de estados de US. |
| **2 (Ancho completo)** | `CustomerDefaultsCard` | Valores por defecto del cliente (Sales Rep, Default Payment Terms, Default Shipping Method, Tax Exempt status). |
| **3 (Ancho completo)** | `CustomerActivity` | Historial consolidado. Tabla con altura dinámica que llena el resto de la pantalla y tiene scroll interno. Muestra cruce de Orders (Ventas) y Estimates (Borradores). |

### Acciones Directas en Toolbar
- **New Order:** Redirige a `/orders/new?customerId=[id]`
- **New Estimate:** Redirige a `/estimates/new?customerId=[id]`

---

## 3. QuickBooks Customer Sincronización

En lugar de depender de Tabs, la información de QuickBooks (`list_id`, `qb_customer_type`) ahora vive de forma nativa en la tarjeta "Customer Details" y sus campos son sincronizados vía `metadata`.

- **ListID:** Se almacena en `metadata.qb_list_id`.
- **Integración Transaccional:** Si un cliente no existe en QB, la función del bridge (`ensureCustomerInQb()`) lo crea automáticamente al momento de mandar un Estimate/Order a QB a través del Admin Proxy.

---

## 4. Known Issues / Maintenance

| Issue | Solución / Prevención |
|-------|------------------------|
| **Columnas Vacías en Tabla** | Verificar que `backend/medusa-config.ts` mantenga el transformer y `displayedAttributes` con los campos personalizados. Si Meilisearch se desincroniza, ejecutar el script `src/scripts/resync-knex.ts` en el backend. |
| **Caché Viejo al Editar (Next.js)** | Las actualizaciones en los modales usan Mutaciones locales de React Query para actualizar el cache del frontend sin recargar la página (`queryClient.invalidateQueries(['customer', id])`). |
