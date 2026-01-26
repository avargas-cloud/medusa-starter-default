# QuickBooks Desktop Bridge (Direct COM)

Este servicio conecta una aplicación Node.js moderna (como Medusa) con **QuickBooks Enterprise 2012 (Legacy)** usando integración directa COM (Windows).

**ESTADO: FUNCIONANDO (PRODUCCIÓN)**

## 🚀 Arquitectura

A diferencia de las soluciones antiguas que usan *Web Connector* (lento, complejo), este bridge usa **Direct COM** a través de scripts de PowerShell.

*   **Node.js (Express):** Recibe peticiones REST de Medusa.
*   **PowerShell Connector:** Habla directamente con `QBXMLRP2` (la libreria interna de QuickBooks).
*   **Sin Configuración:** Se conecta automáticamente a la empresa que tengas abierta (`.qbw`).

---

## 🛠️ Instalación y Puesta en Marcha

### Prerrequisitos (Servidor Windows)
*   Windows Server con QuickBooks Enterprise 2012 instalado.
*   Node.js v14+ instalado.
*   Git instalado.

### 1. Instalación
```powershell
# 1. Clonar el repositorio
git clone <URL_DEL_REPO> C:\Projects\quickbooks-bridge
cd C:\Projects\quickbooks-bridge

# 2. Instalar dependencias (CRÍTICO: esto instala las herramientas de compilación)
npm install
```

### 2. Compilación (Build)
El código está en TypeScript (`src/`), así que **SIEMPRE** debes compilar antes de ejecutar.
```powershell
npm run build
```
*Si ves una carpeta `dist/`, todo salió bien.*

### 3. Iniciar Servicio
```powershell
npm start
```
*Verás: "QuickBooks Bridge Service started successfully"*

---

## 📖 Manual de Uso y Comandos

Para ver la guía completa de integración, solución de errores y ejemplos de JSON, consulte la Biblia:

👉 **[LEER LA BIBLIA DE INTEGRACIÓN (INTEGRATION_BIBLE.md)](INTEGRATION_BIBLE.md)**

---

## ⚡ Solución Rápida de Problemas

### "Timeout" o "Se queda pegado"
QuickBooks tiene una ventana emergente abierta (Warning, Notificación, etc.).
*   **Solución:** Cierra todas las ventanas en QuickBooks o reinícialo.

### "QuickBooks found an error when parsing..."
Error de sintaxis XML.
*   **Solución:** Asegúrate de que tu código está actualizado (`git pull`) y **recompilado** (`npm run build`).

### "Invalid Reference" (Error 3140/3240)
Estás enviando un ID que no existe o un Nombre donde va un ID.
*   **Solución:** Usa los endpoints de "Radar" (`GET /api/products`, etc.) para obtener los `ListID` reales de la empresa actual.

---

## 💻 Comandos REST API

| Método | Endpoint | Descripción |
| :--- | :--- | :--- |
| **GET** | `/api/products` | Busca productos (Stock, Precio, ListID) |
| **POST** | `/api/customers` | Busca o crea clientes |
| **POST** | `/api/invoices` | Crea Facturas (Cuentas por Cobrar) |
| **POST** | `/api/sales-receipts` | Crea Ventas de Contado (Sales Receipts) |
| **GET** | `/api/meta/payment-method` | Lista Métodos de Pago (Visa, Cash, etc.) |
| **GET** | `/api/meta/sales-rep` | Lista Vendedores (Sales Reps) |
