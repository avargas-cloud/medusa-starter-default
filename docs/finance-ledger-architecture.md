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

### Caso 2: Cliente compra $71.42 dólares por el Sitio Web en Shopify/Authorize.net.
1. La orden Web se aprueba en Medusa. 
2. Se dispara nuestro Suscriptor silente `finance-payment-captured.ts`.
3. El Suscriptor detecta el evento de AuthNet, averigua que el customer era John Doe.
4. **Crea un** `CustomerPayment` por `7142` centavos con fuente `web`. **IMPORTANTE:** Este pago se guarda con un campo especial llamado `locked_order_id`, amarrándolo permanentemente a la Orden Web que lo originó.
5. Como es Web y no hay factura vinculada inicialmente, el pago se queda en estatus de **`available`** en la billetera.
6. **Regla Estricta:** Si el usuario del POS intenta utilizar el saldo disponible (`available credit`) para pagar una factura equis (`inv_999`), el sistema **filtra y bloquea** este pago de $71.42. El pago web *solo* puede consumirse si la factura de destino pertenece a su misma orden de origen.

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

## 6. Scripts y Herramientas Administrativas

A continuación los archivos críticos al hacer mantenimiento de este sistema:

- `src/subscribers/finance-payment-captured.ts` : Transfiere las compras web al Ledger. Posee la multiplicación `* 100` crítica para pasar los reportes de Dólares Reales (Medusa Native API) hacia Centavos Universales (Finance DB).
- `src/api/admin/finance/customers/[id]/balance/route.ts`: Formula matemática principal para cuadrar la deuda, explicada arriba.
- `.../invoices/route.ts` & `.../invoices/[id]/payments/route.ts`: Donde ocurren las "Operaciones Atómicas"; es decir, si se crea un invoice con un deposito anticipado, ambos se amarran simultáneamente o ambos fallan (Rollback) por seguridad pericial. 
- `/convert-cents.ts` (Opcional): Usable en terminal via `npx medusa exec ... ` para sanear pagos de transiciones antiguas que pasaron en coma flotante por error antes de unificar toda la unidad contable a centavos base entera.
