# 📋 Plan de Migración de Clientes (QuickBooks -> Medusa)

Este documento detalla la estrategia **"Silent Activation"** para importar 6000 clientes activos e inactivos sin causar fricción ni problemas de seguridad.

---

## 1. Estrategia: "Silent Activation"

### El Problema
Clientes existen en QB pero no tienen cuenta online. Si se registran manualmente, podría dar error "Email ya existe".

### La Solución
1.  Importamos a todos los clientes a Medusa.
2.  Les asignamos una bandera oculta: `metadata: { is_pre_imported: true }`.
3.  **Frontend (Próximo paso):** Cuando un usuario intente registrarse con un email existente:
    -   Si tiene la bandera `true` -> Enviar email de "Bienvenido/Reset Password" en lugar de error.
    -   Si NO tiene la bandera -> Mostrar error estándar "Cuenta ya existe".

---

## 2. Archivos Requeridos (CSV)

Necesitaremos generar dos archivos CSV desde QuickBooks para mañana:

### A. Clientes (`customers_import.csv`)
Datos principales del cliente.
*   **Columnas:** `Email,FirstName,LastName,QuickBooksID,CompanyName,Phone`
*   **Nota:** El Email es el identificador clave.

### B. Direcciones (`addresses_import.csv`)
Todas las direcciones de envío/facturación asociadas.
*   **Columnas:** `Email,Address1,Address2,City,State,Zip,Country,Phone`
*   **Relación:** Se usa el campo `Email` para saber a qué cliente pertenece cada dirección.

---

## 3. Próximos Pasos (Mañana)

1.  **Generar CSVs:** Dejar corriendo la extracción de QuickBooks toda la noche.
2.  **Actualizar Script:** Modificaré `import-customers.ts` para que:
    -   Lea `addresses_import.csv`.
    -   Cree los clientes con la bandera `is_pre_imported`.
    -   Añada todas las direcciones correspondientes a cada cliente.
3.  **Ejecución:** Correr el script para poblar la base de datos.
4.  **Frontend:** Ajustar el formulario de registro y login en la tienda.

---

## 4. Comandos

Para ejecutar la importación (cuando los archivos estén listos):

```bash
yarn medusa exec ./src/scripts/import-customers.ts
```
