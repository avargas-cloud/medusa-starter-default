# 📘 QuickBooks Bridge: La Biblia de Integración (Manual Completo)

> **Versión:** 2.0 (Producción)
> **Tecnología:** Node.js + QBXML via Web Connector (QBWC)
> **Compatibilidad:** QuickBooks Desktop Enterprise (requiere Advanced Inventory para Inventory Sites)
> **QBXML Version:** 10.0


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Master reference (in Spanish) for the custom QuickBooks-Medusa Bridge — the complete integration bible covering architecture, data mapping, authentication, sync logic, and all operational procedures for the EcoPowerTech QuickBooks connection. |
| **Problemas que resuelve** | The QuickBooks integration required a custom Node.js bridge service because there's no off-the-shelf Medusa v2 QuickBooks connector. This doc is the authoritative reference for everything about how the bridge works, how data flows between systems, and how to troubleshoot it. |
| **Resultado esperado** | Any developer can understand, operate, or extend the QuickBooks Bridge from this document. Covers customer import, product sync, and the full order lifecycle. |
| **Scripts Creados** | `import-customers-from-qb.ts` |

Este documento es la **fuente de verdad absoluta**. Sigue estos pasos para instalar el sistema desde CERO en un servidor Windows virgen.

---

## 🏗️ FASE 1: Preparación del Servidor

Antes de tocar código, el servidor debe tener las herramientas básicas.

### 1. Sistema Operativo
*   Windows Server 2008 R2, 2012, 2016, 2019 o superior.
*   **QuickBooks Desktop** instalado y activado.

### 2. Instalar Node.js
El "cerebro" del sistema.
1.  Descarga la versión LTS de 32-bits o 64-bits (recomiendo v16 o v18): [Descargar Node.js](https://nodejs.org/en/download/)
    - ⚠️ **Windows Server 2008**: Máximo Node.js v12.22.12 (ver `NODE_V12_COMPATIBILITY.md`)
2.  Instala con opciones por defecto ("Next", "Next", "Next").
3.  Abre PowerShell y verifica:
    ```powershell
    node -v
    npm -v
    ```

### 3. Instalar Git
Para descargar el código.
1.  Descarga: [Git for Windows](https://git-scm.com/download/win)
2.  Instala con opciones por defecto.
3.  Verifica:
    ```powershell
    git --version
    ```

---

## 🚀 FASE 2: Instalación del Proyecto

El código fuente debe descargarse y "compilarse" (traducirse de TypeScript a JavaScript).

### 1. Clonar el Repositorio
Abre PowerShell como **Administrador** y ve a la carpeta raíz de tu disco C:
```powershell
cd C:\
mkdir Projects
cd Projects
git clone https://github.com/avargas-cloud/quickbooks-bridge.git
cd quickbooks-bridge
```

### 2. Instalar Dependencias (CRÍTICO)
Este paso descarga las librerías necesarias y el compilador.
```powershell
npm install
```
*Si ves advertencias (warnings) en amarillo, es normal.*

### 3. Compilar el Código (Build)
El servidor no puede leer los archivos `.ts` (TypeScript). Debes generar la carpeta `dist`.
```powershell
npm run build
```
✅ **Éxito:** Si el comando termina sin errores rojos y aparece una carpeta llamada `dist` en el proyecto.

---

## ⚙️ FASE 3: Configuración

1.  Copia el archivo de ejemplo:
    ```powershell
    copy .env.example .env
    ```
2.  *(Opcional)* Edita el archivo `.env` con el Bloc de Notas si quieres cambiar el puerto (por defecto es 3000).

---

## ▶️ FASE 4: Ejecución en Producción

El puente necesita estar corriendo para funcionar.

### Modo Manual (Recomendado para verificar)
1.  Abre **QuickBooks** y entra a la empresa correcta.
2.  Abre **QB Web Connector** (QBWebConnector.exe) — debe estar configurado con `Medusa Bridge V2`.
3.  En PowerShell:
    ```powershell
    npm start
    ```
4.  **PRIMERA VEZ:** QuickBooks mostrará una ventana de certificado.
    *   Selecciona: 🔘 **Yes, always allow access even if QuickBooks is not running.**
    *   Click en "Continue" -> "Done".

✅ **Éxito:** Verás en la consola el servidor iniciando en puerto 3000 y el túnel conectado.

### 🚀 Automatización con PM2 (Producción)
**MÉTODO OFICIAL (Feb 2026):**
Usar PM2 para gestionar el proceso del bridge.

```powershell
# Instalar PM2 globalmente (solo una vez)
npm install -g pm2

# Iniciar con PM2 (usa ecosystem.config.js incluido)
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Seguir instrucciones para inicio automático en Windows
```

**Para reiniciar limpio:**
```powershell
.\clean-restart.bat
```

Este script para el bridge, hace git pull, y lo reinicia. Incluye detección de EADDRINUSE y limpieza automática.

**Web Connector:** Debe tener "Auto-Run" activado y `Every_N_Minutes = 1`.

### 🛡️ Seguridad y "Headless" (Sin Ventanas)
Para que funcione sin abrir QuickBooks (Headless) en Windows Server 2011/2012:

1.  **IE Enhanced Security:** DEBE estar desactivado. Si la UI está bloqueada, usar hacks de Registro (ver historial de chat o scripts de soporte).
2.  **Web Connector:** Debe tener "Auto-Run" activado.
3.  **QuickBooks:** Debe haber otorgado permiso tipo "Yes, always allow access even if QuickBooks is not running".

**Estado Actual:** ✅ CONFIRMADO FUNCIONANDO (26 Ene 2026).

## 📡 FASE 5: Uso de la API (Reglas y Comandos)

La API escucha en `http://localhost:3000/api`.

### 🔑 Regla Sagrada: "ListID vs FullName"
QuickBooks odia las imprecisiones. Si envías "Visa" y es "VISA", falla.
*   **SOLUCIÓN:** Usa siempre **ListID** (códigos únicos estilo `8000ABCD-12345678`).
*   Nunca adivines un ID. Búscalo con la API primero.

### 1. Comandos de Exploración (Radar)
Úsalos para obtener los IDs de productos, clientes, etc.

**Buscar un Producto:**
```powershell
# Ver precios, stock y ListID
$url = "http://localhost:3000/api/products?FullName=NOMBRE_EXACTO"
Invoke-RestMethod -Uri $url -Method Get
```

**Buscar un Cliente:**
```powershell
# Obtener ListID del cliente
$body = @{ action = "query"; FullName = "Pepito Perez" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3000/api/customers" -Method Post -Body $body -ContentType "application/json"
```

**Buscar Vendedores y Métodos de Pago:**
```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/meta/sales-rep" -Method Get
Invoke-RestMethod -Uri "http://localhost:3000/api/meta/payment-method" -Method Get
```

### 4. Mapeo Masivo de SKUs (Selective Sync)
Para sincronizar solo los productos que existen en Medusa (506 SKUs) y obtener sus precios/stock de QB:

**Herramienta:** `generate_sku_mapping.ps1`
**Ubicación:** `C:\Projects\quickbooks-bridge\scripts\`

**Pasos:**
1. Abre PowerShell como Administrador.
2. Navega a la carpeta: `cd C:\Projects\quickbooks-bridge\scripts`
3. Ejecuta el script:
   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force
   .\generate_sku_mapping.ps1
   ```
4. **Resultado:** Generará un archivo `sku_mapping_legacy.csv` con:
   *   `SKU` (Nombre en QB)
   *   `ListID` (ID vital para sync)
   *   `SalesPrice` (Precio)
   *   `QuantityOnHand` (Stock)

**Nota:** Este script es robusto; guarda progreso línea por línea y maneja errores de desconexión.

### 6. Exportación Masiva de Clientes (Medusa Migration)
Para migrar los clientes a Medusa V2 con todos los datos B2B (Términos, Impuestos, Límites de Crédito).

**Herramienta:** `export_customers.ts` (Script de TypeScript)
**Ubicación:** `C:\Projects\quickbooks-bridge\scripts\`

**Pasos:**
1. Abre PowerShell en la raíz del proyecto.
2. Ejecuta:
   ```powershell
   npx ts-node scripts/export_customers.ts
   ```
3. **Resultado:** Se generarán dos archivos en `scripts/`:
   *   `customers_export.json`: JSON estructurado listo para importación.
   *   `customers_export.csv`: CSV para revisión rápida en Excel.

**Campos Extraídos (B2B Enhanced):**
*   `FirstName` / `LastName` (Separados para marketing).
*   `Terms` (Ej: Net 30, Due on Receipt).
*   `AccountNumber`
*   `CreditLimit` (Límite de Crédito).
*   `TaxCode` / `ResaleNumber` (Exenciones fiscales).
*   `Billing/Shipping Address` (Direcciones desglosadas por calle, ciudad, zip).

---

### 7. Sincronización de Inventario (Optimizada)

El sistema ahora **filtra automáticamente** los productos inactivos para acelerar la carga (de ~5000 a ~2000 productos).

**Para probar la descarga masiva:**
Debido a que PowerShell viejo (v2.0) tiene problemas con JSONs grandes, usa el script de Node.js incluido:

```powershell
node test_inventory.js
```
*Este script iniciará la descarga, esperará pacientemente y te dirá la cantidad exacta de productos activos.*

### 2. Crear Producto (VERIFICADO)
Ya no necesitas buscar IDs. El sistema acepta los nombres de cuentas estándar ("Sales", "Cost of Goods Sold", "Inventory Asset").

**Comando PowerShell para crear producto:**
```powershell
$headers = @{ "x-api-key" = "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD" }
$body = @{
    Name = "Producto Test API V2"
    SalesPrice = 99.99
    IncomeAccountRef = @{ FullName = "Sales" }
    COGSAccountRef = @{ FullName = "Cost of Goods Sold" }
    AssetAccountRef = @{ FullName = "Inventory Asset" }
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://ecopower-qb.loca.lt/api/products" -Headers $headers -Body $body -ContentType "application/json"
```

### 3. Leer Información del Cliente (VERIFICADO)
Si obtienes un resultado vacío, usa este comando para ver el **XML CRUDO** que nunca falla:

```powershell
# Reemplaza ID_OPERACION con el ID que te dio el POST anterior
$id = "ID_OPERACION"
$headers = @{ "x-api-key" = "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD" }
$res = Invoke-RestMethod -Method Get -Uri "https://ecopower-qb.loca.lt/api/sync/status/$id" -Headers $headers
$res.operation.qbxmlResponse
```
*Esto mostrará `<Name>123 Supply</Name>`, `<Phone>...</Phone>`, etc.*
---

## 🛠️ FASE 6: Solución de Problemas (Troubleshooting)

### 🛑 "Timeout" o "Waiting for response..."
**Síntoma:** Envías el comando y se queda cargando por 45 segundos hasta fallar.
**Causa:** QuickBooks abrió una ventana emergente oculta (alerta de stock, ortografía, certificado vencido) y está esperando un click manual.
**Solución:**
1. Ve al servidor físico.
2. Mira QuickBooks. ¿Hay ventanas abiertas? Ciérralas.
3. Reinicia la aplicación (`Ctrl + C` -> `npm start`).

### 🛑 Error: "QuickBooks found an error when parsing..."
**Síntoma:** El log muestra `Parsing Error` en `SalesOrderAdd` o `EstimateMod`/`EstimateAdd` (error código `0x80040400`).
**Causa:**
1.  **Orden de Campos (CRÍTICO):** QBXML es estricto.
    *   `SalesOrderLine`: `<Desc>` DEBE ir antes de `<Quantity>`.
    *   `InvoiceAdd`: `<TxnDate>` y `<RefNumber>` DEBEN ir antes de `<LinkToTxnID>`.
    *   `InventorySiteRef` DEBE ir DESPUÉS de `<Amount>` (no antes — error `0x80040400`).
2.  **Caracteres Especiales en FullName:** `&` en nombres de items o clientes (ej: "A&B Corp" o "SHIPPING & HANDLING"). Aunque el XML escape el ampersand a `&amp;`, QuickBooks Desktop **silenciosamente falla** al parsearlo, retornando `0x80040400`.
    *   **Solución:** Mapear SIEMPRE por `ListID` (`<ItemRef><ListID>800006A3-...</ListID></ItemRef>`) en los builders en lugar de `<FullName>`, en particular para items fijos de servicio/envío.
3.  **Amount vs Rate en Estimates:** En `<EstimateLineAdd>` o `<EstimateLineMod>`, enviar `<Amount>` en lugar de `<Rate>`. QuickBooks re-calcula el rate erróneamente multiplicándolo por el Cost si se envía el Rate.
4. **Solución general:** Usar siempre la función `escapeXml()` en los builders (ya implementada).

### 🛑 Error 3070: "String is too long"
**Síntoma:** Falla al crear Invoice o Payment.
**Causa:** El campo `RefNumber` excede 11 caracteres.
**Solución:** Deja que QuickBooks asigne el número automáticamente (no envíes `RefNumber`) o acórtalo a máx 11 caracteres.

### 🛑 Error 3140: "Invalid Reference"
**Síntoma:** Falla al usar un `ListID` de producto o cliente.
**Causa:** El `ListID` enviado no existe en QB.
**Solución:** Verificar con `GET /api/products?FullName=SKU` o `GET /api/customers?ListID=...` primero.

### 🛑 Precio multiplicado por ~7.4x
**Causa:** Se envió `<Rate>` en lugar de `<Amount>` en un producto con UOM Set.
**Solución:** El Bridge debe usar `<Amount> = qty × price</Amount>` — esto ya está implementado correctamente. Verificar que el bridge esté actualizado con `git pull` + `npm run build`.

### 🛑 WC atascado al 20%
**Causa:** Hay operaciones obsoletas en la cola.
**Solución:** Eliminar `queue-state.json` y reiniciar el bridge.

## 📦 FASE 7: Workflow Completo (Sales Order -> Invoice -> Payment)
*Verificado en Enero 2026*

### Estrategia de IDs
1.  **Medusa:** Guarda el `TxnID` que devuelve el Bridge.
2.  **Bridge:** Devuelve el objeto completo `Ret` (Return) en el JSON.
3.  **Persistencia:** Es responsabilidad del Caller (Medusa) guardar:
    *   `qb_sales_order_txn_id` (Para luego crear el Invoice).
    *   `qb_invoice_txn_id` (Para luego aplicar el pago).
    *   Siempre guardar también el `refNumber` para referencia humana en QB Desktop.

### Flujo de Prepago (Prepayment) — E-commerce
Para cobrar al momento de la orden pero facturar después:
1.  **Paso 1:** Crear `SalesOrder`.
2.  **Paso 2:** Crear `ReceivePayment` con `autoApply: false` (queda como Crédito en la cuenta).
3.  **... Días después (al despachar) ...**
4.  **Paso 3:** Crear `Invoice` vinculado a la `SalesOrder` (`LinkToTxnID`).
5.  **Paso 4:** Aplicar el Crédito a la Factura (`POST /api/payments` con `invoiceId` + `creditTxnId`).

---

## 🤓 ANEXO TÉCNICO: Recetas XML Estrictas (QBXML)

**ADVERTENCIA:** QuickBooks 2012/13 es extremadamente estricto con el orden de las etiquetas. Si cambias el orden, obtendrás el error `QuickBooks found an error when parsing`.

### 1. SalesOrderAdd (Orden de Venta)
**Reglas:**
- `<Desc>` va ANTES de `<Quantity>`.
- `<InventorySiteRef>` SIEMPRE **después** de `<Amount>`.
- Usar `<Amount>` (precio × qty) en lugar de `<Rate>` para evitar multiplicación por UOM.
- `<DataExt>` (Custom Fields) NO se puede enviar al crear.
- En el `<Memo>` usar el RefNumber del Estimate (ej: `"From Estimate E18024527"`), NO el TxnID.

```xml
<SalesOrderAddRq>
  <SalesOrderAdd>
    <CustomerRef>...</CustomerRef>
    <ClassRef>...</ClassRef>      <!-- Opcional -->
    <TemplateRef>...</TemplateRef> <!-- Opcional -->
    <TxnDate>YYYY-MM-DD</TxnDate>
    <RefNumber>...</RefNumber>
    <PONumber>...</PONumber>
    <TermsRef>...</TermsRef>
    <SalesRepRef>...</SalesRepRef>
    <ShipMethodRef>...</ShipMethodRef>
    <Memo>From Estimate E18024527</Memo>  <!-- Usar RefNumber, no TxnID -->

    <!-- LÍNEAS DE PRODUCTO -->
    <SalesOrderLineAdd>
      <ItemRef><ListID>800019EA-...</ListID></ItemRef>
      <Desc>...</Desc>           <!-- Descripción PRIMERO -->
      <Quantity>...</Quantity>   <!-- Cantidad DESPUÉS -->
      <Amount>precio×qty</Amount>  <!-- Usar Amount, no Rate (evita multiplicación por UOM) -->
      <InventorySiteRef><ListID>80000001-1331053531</ListID></InventorySiteRef>  <!-- DESPUÉS de Amount -->
    </SalesOrderLineAdd>
  </SalesOrderAdd>
</SalesOrderAddRq>
```

> **⚠️ CRÍTICO:** `<InventorySiteRef>` debe ir SIEMPRE **después** de `<Amount>`. Si va antes, QB retorna error `0x80040400`.

### 2. InvoiceAdd (Factura Vinculada a Sales Order)
**Regla de Oro:** La fecha y número (`TxnDate`, `RefNumber`) van **ANTES** que el enlace (`LinkToTxnID`).
```xml
<InvoiceAddRq>
  <InvoiceAdd>
    <CustomerRef>...</CustomerRef>
    <ClassRef>...</ClassRef>
    <ARAccountRef>...</ARAccountRef>
    <TemplateRef>...</TemplateRef>
    <TxnDate>YYYY-MM-DD</TxnDate>       <!-- 1. Fecha -->
    <RefNumber>...</RefNumber>          <!-- 2. Número -->
    <LinkToTxnID>1B60F5...</LinkToTxnID><!-- 3. Enlace al SO (AL FINAL del header) -->
    <!-- No lleva líneas si está vinculada al SO completo -->
  </InvoiceAdd>
</InvoiceAddRq>
```

### 3. ReceivePaymentAdd (Pago)
**Regla de Oro:** `IsAutoApply` debe omitirse o ser falso si usas `AppliedToTxnAdd`.
```xml
<ReceivePaymentAddRq>
  <ReceivePaymentAdd>
    <CustomerRef>...</CustomerRef>
    <TxnDate>...</TxnDate>
    <RefNumber>...</RefNumber>
    <TotalAmount>10.00</TotalAmount>
    <PaymentMethodRef>...</PaymentMethodRef>
    <Memo>...</Memo>
    <DepositToAccountRef>...</DepositToAccountRef>

    <!-- OPCIÓN A: Auto-aplicar a la deuda más vieja -->
    <IsAutoApply>true</IsAutoApply>

    <!-- OPCIÓN B: Pagar una factura específica -->
    <!-- (Sin IsAutoApply) -->
    <AppliedToTxnAdd>
      <TxnID>1B60F9...</TxnID> <!-- ID de la Factura -->
      <PaymentAmount>10.00</PaymentAmount>
    </AppliedToTxnAdd>
  </ReceivePaymentAdd>
</ReceivePaymentAddRq>
```

---

**Desarrollado por:** Equipo de Integración Medusa-QB.
**Última Actualización:** 27 de Febrero, 2026. (v2.0 — Actualizado a QBWC, Amount vs Rate, PM2, errores adicionales)
