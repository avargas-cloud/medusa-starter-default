# EcoPowerTech - Customer Finance Ledger Architecture

## 1. Introducción
El módulo **Finance** en EcoPowerTech es el núcleo para gestionar el dinero de los clientes. Funciona como un **Libro Mayor Unificado (Single Ledger)**. Esto significa que todo dinero que ingresa al sistema por parte de un cliente (ya sea en la tienda o a través de la web) va a parar a un único lugar: el fondo de fondos del cliente (`CustomerPayment`).

Este documento está diseñado para cualquier desarrollador que lea el código del Backend por primera vez, permitiendo comprender de dónde salen los balances y cómo interactúan las facturas con los pagos Web y POS.

---

## 2. El Problema a Resolver
Normalmente, el E-Commerce y el Point of Sale (POS) son dos bestias gigantes que manejan la plata por separado.
- En la Web, un cliente pasa su tarjeta de crédito y la orden se marca "pagada". 
- En el POS, se le emite una factura (`PosInvoice`) a un distribuidor a 30 días, y luego este viene con un cheque para pagarla parciamente.

¿Qué ocurre si ese cliente de la Web devuelve su producto y ahora tiene $100 a su favor, pero también nos debe $50 de una factura de ayer en la tienda física? 
Necesitamos que los $100 se reflejen en un único estado de cuenta global para el cliente, y que sea posible cruzar esos créditos contra la deuda de la tienda. Para hacer que E-commerce y Arquitectura B2B hablen un mismo idioma financiero, nace el **Finance Ledger**.

---

## 3. Modelo de Datos Central
El módulo se compone de **tres tablas maestras** fundamentales que interactúan con Medusa:

### A. `CustomerPayment` (El Ingreso o La Billetera)
Representa billetes físicos o transacciones bancarias concretas adjudicadas a un cliente. Nunca se borran, son auditables.

**Campos clave:**
- `source`: De dónde vino el pago (`web` o `pos`).
- `amount`: Monto total ingresado (guardado matemáticamente en **centavos**, ej: $71.42 = `7142`).
- `locked_order_id`: Si tiene valor (ej. Pagos Web Automáticos), el dinero de este billete **solo** puede usarse para pagar facturas originadas desde esta misma orden. Protege los fondos Web de ser consumidos cruzados por error.
- `status`: El estado de vida del pago.
   - `available`: Ingresó el dinero, pero aún no se asigna a deudas. "Crédito a favor".
   - `partially_applied`: Parte del dinero se gastó pagando facturas, queda un remanente.
   - `applied`: Los fondos se agotaron al 100% en facturas vencidas.
   - `voided`: Operación anulada/reversada.

### B. `PosInvoice` (La Deuda o Las Facturas)
Creado en el módulo de facturación cada vez que se quiere cobrarle al cliente algo que retiró de la bodega por el POS. (Las compras Web *NO* generan este documento de forma nativa a menos que se importen manualmente).

**Campos clave:**
- `total`: Monto adeudado en centavos.
- `payment_status`: `unpaid`, `partial`, `paid`.

### C. `PaymentApplication` (El Puente de Consumo)
Es el "Baucher" o ticket que documenta cuando y cuánto dinero de la Billetera (`CustomerPayment`) se extrajo para liquidar una Deuda (`PosInvoice`).

**Campos clave:**
- `payment_id`: ID del `CustomerPayment`.
- `invoice_id`: ID del `PosInvoice` (si aplica).
- `amount_applied`: Cuántos centavos se extrajeron de la billetera en esta operación.

---

## 4. Flujo de Trabajo en Acción (Casos de Uso)

### Caso 1: Cliente paga $500 en efectivo por un Invoice viejo de $1000 en el POS.
1. El POS llama la API para "Agregar Pago" a la factura `inv_001`.
2. El modulo Finance interviene silenciosamente:
3. **Crea un** `CustomerPayment` de $500 (`amount=50000`) de fuente `pos`.
4. El sistema lee que el pago venía dirigido a una factura en particular, e inmediatamente se auto-consume creando una `PaymentApplication` que vincula ese recién nacido pago contra el `inv_001` por la suma de `50000` centavos.
5. El estatus del `CustomerPayment` salta instantáneamente de `available` a `applied` cerrado, porque se asimiló completo.

### Caso 2: Cliente compra $71.42 dólares por el Sitio Web / Authorize.net.
1. La orden Web se aprueba en Medusa (`completeCartWorkflow` completa exitosamente).
2. Se dispara el hook `orderCreated` en `maintain-cart-prices.ts` (síncrono — garantizado, no depende del bus de Redis).
3. El hook obtiene el pago de Medusa (`payment.amount` en **dólares**, e.g. `71.4275`), convierte a centavos: `Math.round(71.4275 * 100) = 7143`.
4. Consulta la secuencia PostgreSQL `custom_payment_seq` para asignar un `display_id` secuencial (ej: `2065`), el mismo que usan los pagos POS.
5. **Crea un** `CustomerPayment` por `7143` centavos con fuente `web`, `display_id=2065`. **IMPORTANTE:** Este pago se guarda con `locked_order_id`, amarrándolo permanentemente a la Orden Web que lo originó.
6. Como es Web y no hay factura vinculada inicialmente, el pago se queda en estatus de **`available`** en la billetera.
7. El hook encola (fire-and-forget vía `setImmediate`) la sincronización a QuickBooks: crea un `ReceivePayment` en QB como crédito sin aplicar, registra el resultado en `qb_order_pipeline`.
8. **Regla Estricta:** Si el usuario del POS intenta utilizar el saldo disponible (`available credit`) para pagar una factura equis (`inv_999`), el sistema **filtra y bloquea** este pago de $71.42. El pago web *solo* puede consumirse si la factura de destino pertenece a su misma orden de origen.

> **Nota técnica:** El subscriber `order.payment_captured` (`qb-order-subscriber.ts`) omite automáticamente las órdenes web. El hook `maintain-cart-prices.ts` es la única fuente de verdad para pagos web — garantiza que el ledger y QB estén sincronizados sin depender del bus de eventos Redis.

### Caso 3: Cliente usa "Store Credit" (Crédito manual o a favor) para abonar a una Factura desde la Orden.
1. Hay pagos pasados manuales en estatus `available`. Cliente tiene $100 a su favor.
2. Quiere pagar un Invoice nuevo por $30 desde la pantalla de Órdenes en el POS. 
3. El Vendedor abre el cajón flotante de pagos, **visualiza la lista de saldos a favor disponibles** y selecciona explícitamente cuál saldo usar. (Si hay saldos amarrados a otras órdenes web por la regla del Caso 2, aparecerán bloqueados/en gris).
4. El sistema crea la `PaymentApplication` consumiendo $30 y el pago original salta a `partially_applied` dejando un saldo vivo de $70.
5. **Recibo Referencial (Tracking Metadata):** Adicionalmente, el sistema inyecta un registro en la *Metadata* de la Orden actuando como un recibo informativo ("Abonaste $30 usando Store Credit"). Su único propósito es salir impreso en el recibo entregado al cliente en ese instante.
6. Si mañana el cliente cancela la compra y ese abono de $30 se deshace para usarse en *otra factura distinta*, la metadata referencial se borra de la primera orden para mantener el historial limpio.

---

## 5. El Cálculo de Balance (El Endpoint Mágico)
La vista del POS que calcula "¿Cuánto debe hoy fulano?" (`/admin/finance/customers/:id/balance`) jamás guarda la deuda temporalmente en una base de datos estática para evitar que el número se atrase. Siempre hace el arqueo matemático "On The Fly" o "Al Vuelo".

**¿Cómo Arquea el Balance?:**
1. Busca TODOS los `PosInvoice` que esten `unpaid` o `partial`. Esto es el **AR (Cuentas por Cobrar)**.
2. Busca TODOS los `CustomerPayment` que esten `available` o `partially_applied`. Luego sub-recorre sus `PaymentApplications` para restar el saldo interno gastado, y así sacar solo el **Crédito Disponible**.
3. Ambos números (las inyecciones de las facturas devuelven centavos y los pagos también) se asocian en una fórmula.
   - `Net Balance` = `AR` - `Crédito Disponible`.
   - Si sale positivo, nos debe plata. 
   - Si sale negativo, nosotros le debemos a él y tiene exceso de crédito a favor.
4. Finalmente el Route lo divide entre 100, para enviar los números mastigados en formato **Moneda Decimal ($)** hacia el UI Frontend del POS.

---

## 6. Métodos de Pago — Fuente de Verdad (System Defaults)

A partir de Abril 2026, la lista de métodos de pago disponibles en el POS ya **no es hardcodeada** en los componentes. Vive en la tabla `system_defaults` bajo `context = "Payment Methods"` y `field_name = "Payment Method"`.

### Estructura de cada método

| Campo | Descripción | Ejemplo |
|---|---|---|
| `value` | Clave interna (slug) | `visa` |
| `metadata.display` | Nombre visible en UI | `Visa` |
| `metadata.icon` | Emoji | `💳` |
| `metadata.ledger_method` | Enum del Finance Ledger | `card` |
| `metadata.qb_method` | Nombre en QB Desktop | `Visa` |
| `sort_order` | Orden de aparición | `2` |

### 16 métodos semilla

| Key | Display | Ledger | QB |
|---|---|---|---|
| cash | Cash | cash | Cash |
| visa | Visa | card | Visa |
| mastercard | Mastercard | card | MasterCard |
| discover | Discover | card | Discover |
| amex | American Express | card | American Express |
| capital_one | Capital One | card | Capital One |
| debit_card | Debit Card | card | Debit Card |
| check | Check | check | Check |
| checking_account | Checking Account | ach | Check |
| money_order | Money Order | check | Check |
| paypal | PayPal | other | *(none)* |
| zelle | Zelle | zelle | Zelle |
| e_check | E-Check | ach | EFT |
| transfer | Transfer | ach | EFT |
| wire_transfer | Wire Transfer | ach | Wire Transfer |
| credit_memo | Credit Memo | credit_memo | *(none)* |

### Cómo los consume el POS

El hook `hooks/usePaymentMethods.ts` hace un fetch a `/admin/system-defaults` y transforma la respuesta al shape `{ id, label, icon, ledger_method, qb_method }`. Tiene:
- **Fallback hardcodeado** — si la API no responde, usa la lista estática completa.
- **Cache de módulo** — un solo fetch por sesión de navegador (no se repite entre componentes).

Todos los modales de pago consumen este hook:
- `CapturePaymentModal.tsx`
- `CaptureDepositModal.tsx`
- `ChangePaymentMethodModal.tsx`
- `complete-order/PaymentSection.tsx`
- `transactions/new/page.tsx`

Para agregar o modificar métodos: **System Defaults → Payment Methods** en el admin de Medusa.

---

## 7. Correcciones al Flujo de Pagos Web (Abril 2026)

### Problema 1: display_id con letras (1TMAG, 7TX69)

**Causa:** `maintain-cart-prices.ts` usaba `container.resolve("__pg_connection__")` con `.raw()` (Knex) para obtener la secuencia `custom_payment_seq`, que fallaba silenciosamente en el contexto de workflow hooks.

**Solución:** Se migró a `getDbPool().query('SELECT nextval(...)')` — el mismo patrón probado que usan las rutas POS.

### Problema 2: Filas duplicadas en `qb_order_pipeline`

**Causa:** Tanto el hook `maintain-cart-prices.ts` como el subscriber `order.payment_captured` procesaban órdenes web.

**Solución:** Se agregó un guardia `isPosOrder()` en el subscriber para saltar órdenes web. El hook es la única fuente de verdad para pagos web.

### Problema 3: Pagos web atascados en "pending" 30 min

**Causa:** El bloque `.catch()` del `setImmediate` de QB solo actualizaba metadata pero **nunca** escribía `status: "failed"` en el pipeline, dejando la fila en pending hasta que el cron de reintentos corría.

**Solución:** Se añadió `writePipelineRow({ status: "failed" })` en el catch, garantizando que el pipeline siempre termina en un estado final.

### Problema 4: QB Error 3140 (paymentMethod inválido)

**Causa:** El hook enviaba `paymentMethod: "Credit Card"` hardcodeado a QB, pero QB Desktop no tiene ese método en la lista de la empresa.

**Solución:** `paymentMethod` ahora es opcional en `QbReceivePaymentPayload`. El hook no envía ningún método por defecto — el correcto se obtiene de system-defaults según el tipo de tarjeta.

---

## 9. Scripts y Herramientas Administrativas

A continuación los archivos críticos al hacer mantenimiento de este sistema:

- `src/workflows/hooks/maintain-cart-prices.ts` : **Fuente principal de pagos web al Ledger.** Se ejecuta sincrónicamente como hook de `completeCartWorkflow.orderCreated`. Hace la conversión `Math.round(payment.amount * 100)` (dólares Medusa → centavos Finance) y asigna `display_id` secuencial vía `custom_payment_seq`. También encola el QB ReceivePayment (fire-and-forget).
- `src/api/admin/finance/payments/route.ts` : Crea pagos POS manualmente. Usa el mismo `custom_payment_seq` para `display_id`. Referencia canónica del patrón de secuencia.
- `src/api/admin/finance/customers/[id]/balance/route.ts`: Formula matemática principal para cuadrar la deuda, explicada arriba.
- `.../invoices/route.ts` & `.../invoices/[id]/payments/route.ts`: Donde ocurren las "Operaciones Atómicas"; es decir, si se crea un invoice con un deposito anticipado, ambos se amarran simultáneamente o ambos fallan (Rollback) por seguridad pericial. 
- `/convert-cents.ts` (Opcional): Usable en terminal via `npx medusa exec ... ` para sanear pagos de transiciones antiguas que pasaron en coma flotante por error antes de unificar toda la unidad contable a centavos base entera.
#### POS Orders Default Channel Bug (March 17, 2026)
Investigated an issue where orders created were saving under `Default Sales Channel`.
- **Estimate Confirm Order**: This function properly created POS metadata and assigned `POS Sales Channel`.
- **New Order (Direct POS)**: The direct order creation payload in `useOrderActions.ts` was missing the `sales_channel_id` entirely, which made the Medusa backend assign the default channel automatically.
- **Admin Panel (Advanced Draft Order)**: The backend UI's modal did not preselect the `POS` channel, causing agents to create quotes manually as `Default`.

**Resolutions applied**:
1. Added `sales_channel_id: process.env.NEXT_PUBLIC_SALES_CHANNEL_ID` and `metadata.pos_created: true` to the direct New Order creation payload inside `useOrderActions.ts`.
2. Updated `backend/src/admin/routes/draft-orders-advanced/components/CreateDraftOrderModal.tsx` to automatically find and preselect the `POS` sales channel upon opening.
