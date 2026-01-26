# 🔐 Estrategia de Autenticación en Astro + Medusa

Integrar Medusa con Astro requiere un enfoque híbrido debido a la naturaleza "Server-First" de Astro.

## 1. Arquitectura General

En Astro, recomendamos usar **"Islands Architecture"** (Islas) para los formularios de Login/Registro.
*   **Framework UI:** React (o Vue/Svelte) para los componentes interactivos (`<LoginForm />`, `<RegisterForm />`).
*   **Librería:** `@medusajs/medusa-js` (Cliente oficial).
*   **Estado:** `Context API` (React) o `Nano Stores` (Astro) para guardar la sesión del usuario.

---

## 2. El Flow "Silent Activation" (La Lógica Clave)

Para lograr la experiencia que diseñamos (detectar si es importado vs. ya registrado), necesitamos un pequeño **Endpoint Personalizado** en Medusa, porque la API estándar no expone la `metadata` públicamente por seguridad.

### Paso A: Backend (Medusa)
Crearemos un endpoint: `POST /store/check-customer-status`
1.  Recibe `{ email }`.
2.  Busca el cliente.
3.  **Lógica:**
    *   Si tiene `is_pre_imported: true`: Dispara el email de "Reset Password" y responde `{ type: "pre_imported" }`.
    *   Si existe pero `false`: Responde `{ type: "registered" }`.
    *   Si no existe: Responde `{ type: "new" }`.

### Paso B: Frontend (Astro/React)
En tu formulario de Registro (`RegisterForm.tsx`):

```typescript
async function handleRegister(data) {
  try {
    // 1. Intentar crear cliente
    await medusa.customers.create(data); 
    // Éxito -> Login automático
  } catch (error) {
    if (error.response.status === 422) { // Email existe
      
      // 2. Consultar nuestro endpoint mágico
      const check = await medusa.client.request("POST", "/store/check-customer-status", { email: data.email });

      if (check.type === "pre_imported") {
         alert("¡Bienvenido de nuevo! Te enviamos un correo para activar tu cuenta importada.");
      } else {
         alert("Este correo ya está registrado. Por favor inicia sesión.");
      }
    }
  }
}
```

---

## 3. Implementación en Astro

### Instalación
```bash
npm install @medusajs/medusa-js axios
```

### Cliente (lib/medusa.ts)
```typescript
import Medusa from "@medusajs/medusa-js"

export const medusa = new Medusa({
  baseUrl: import.meta.env.PUBLIC_MEDUSA_BACKEND_URL,
  maxRetries: 3,
})
```

### Manejo de Sesión
Medusa usa **Cookies** (`connect.sid`).
*   Asegúrate de que `baseUrl` en el cliente coincida con tu backend.
*   Si están en dominios diferentes (ej: `tienda.com` y `api.tienda.com`), configura **CORS** en Medusa y `withCredentials: true` en el cliente.

---

## 4. Próximos Pasos Técnicos

1.  **Backend:** Crear la ruta `src/api/store/check-customer-status/route.ts` en Medusa.
2.  **Frontend:** Implementar el formulario en Astro siguiendo este diagrama.
