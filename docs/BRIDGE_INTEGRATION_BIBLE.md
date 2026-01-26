# 📘 QuickBooks Bridge: La Biblia de Integración (Manual Completo)

> **Versión:** 1.0 (Producción)
> **Tecnología:** Node.js + Direct COM (Sin Web Connector)
> **Compatibilidad:** QuickBooks Desktop 2012 - 2024 (Enterprise, Pro, Premier)

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
2.  En PowerShell:
    ```powershell
    npm start
    ```
3.  **PRIMERA VEZ:** QuickBooks mostrará una ventana de certificado.
    *   Selecciona: 🔘 **Yes, always allow access even if QuickBooks is not running.**
    *   Usuario de Login: Admin (o el usuario que uses).
    *   Click en "Continue" -> "Done".

✅ **Éxito:** Verás en la consola:
INFO: Mode: Direct COM (No Web Connector required)
```

### 🚀 Automatización (Inicio Automático)
Para que el sistema arranque solo cuando inicias sesión (o se reinicia el servidor):

1.  Haz `git pull` para bajar el archivo `START_ALL.bat`.
2.  Presiona `Win + R` en el teclado.
3.  Escribe `shell:startup` y dale Enter.
4.  Crea un **Acceso Directo** al archivo `C:\Projects\quickbooks-bridge\START_ALL.bat` dentro de esa carpeta de inicio.

**Resultado:** Cada vez que el usuario entre a Windows, se abrirán las dos ventanas negras (Servidor + Túnel) automáticamente. ¡Solo minimízalas!

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

### 3. Sincronización de Inventario (Optimizada)

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
**Síntoma:** El log muestra `Parsing Error`.
**Causa:** El código que corre el servidor es viejo y genera XML inválido.
**Solución:**
```powershell
git pull       # Bajar cambios
npm run build  # Recompilar (¡IMPORTANTE!)
npm start      # Iniciar
```

### 🛑 Error 3140: "Invalid Reference"
**Síntoma:** El log dice `Invalid Reference to CustomerRef` o `ItemRef`.
**Causa:** El `ListID` que enviaste no existe en la empresa abierta actualmente.
**Solución:** Usa los comandos de "Radar" (Fase 5) para buscar el ID correcto en ESTA empresa.

### 🛑 Git Conflict ("Local changes would be overwritten")
**Síntoma:** `git pull` falla.
**Solución:**
```powershell
git reset --hard
git pull
npm run build
```

---

**Desarrollado por:** Equipo de Integración Medusa-QB.
