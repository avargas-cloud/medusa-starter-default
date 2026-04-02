# Storage — MinIO
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

MinIO es el proveedor de almacenamiento S3-compatible self-hosted que reemplaza el almacenamiento local de disco de Medusa. En Railway, los volumenes de disco son efimeros — cualquier archivo subido se pierde en el siguiente redeploy. MinIO provee almacenamiento persistente y sirve las imagenes via URLs publicas.

### Modulo activo: smart-storage (custom)

El modulo activo registrado en `modules[]` es `smart-storage` (`id: "smart-s3"`). Extiende S3 con folder routing automatico basado en el contexto del upload.

El plugin `@medusajs/file-s3` esta presente en `package.json` y en `plugins[]` de `medusa-config.ts` como legacy, pero NO es el provider activo.

---

## Arquitectura

```
Admin UI (upload)
    |
    | x-upload-context header ("products" | "categories")
    v
POST /admin/uploads
    | agrega phantom prefix al filename:
    | "context_products_photo.jpg" o "context_categories_img.jpg"
    v
Smart Storage Module (./src/modules/smart-storage, id: "smart-s3")
    | detecta prefix → rutea a carpeta → elimina prefix → construye key final
    v
AWS SDK S3Client → MinIO endpoint (Railway)
    v
Bucket medusa-media/
├── products/    ← imagenes de productos
├── categories/  ← imagenes de categorias
└── content/     ← assets generales (sin contexto)

Archivos protected:
└── protected/   ← via uploadProtected(), no public-read
```

### Phantom Prefix System

El contexto se pasa a traves del workflow de Medusa sin modificar el core usando prefijos en el filename:

| Prefix en filename | Carpeta destino |
|-------------------|----------------|
| `context_products_` o `prod_` | `products/` |
| `context_categories_` o `cat_` | `categories/` |
| Sin prefix | `content/` |

El prefix se elimina antes de guardar. El archivo final es: `products/filename-{timestamp}.ext`

### Context Detection (frontend → upload)

**Productos:** El widget `upload-context-interceptor.tsx` intercepta fetch/XHR globalmente e inyecta `x-upload-context` segun la URL actual:
- `/products` → `"products"`
- `/categories` → `"categories"`

**Categorias:** La category widget usa direct fetch con header explicito (el SDK de Medusa no pasa headers custom):
```typescript
const response = await fetch(`${BASE_URL}/admin/uploads`, {
    method: "POST",
    headers: { "x-upload-context": "categories" },
    credentials: "include",
    body: formData,
})
```

---

## Configuracion en medusa-config.ts

```typescript
// modules[] — provider activo
{
  resolve: "@medusajs/medusa/file",
  options: {
    providers: [
      {
        resolve: "./src/modules/smart-storage",
        id: "smart-s3",
        options: {
          file_url: `${process.env.MINIO_ENDPOINT}/${process.env.MINIO_BUCKET}`,
          accessKeyId: process.env.MINIO_ACCESS_KEY,
          secretAccessKey: process.env.MINIO_SECRET_KEY,
          region: "us-east-1",   // MinIO no usa regiones pero AWS SDK lo requiere
          bucket: process.env.MINIO_BUCKET,
          endpoint: process.env.MINIO_ENDPOINT,
        },
      },
    ],
  },
}

// plugins[] — legacy, NO es el provider activo
{
  resolve: "@medusajs/file-s3",
  options: {
    file_url: process.env.MINIO_ENDPOINT,
    // ... MinIO options
    s3_force_path_style: true,
  },
}
```

### AWS SDK S3Client — config importante

```typescript
new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    region: "us-east-1",       // requerido por SDK aunque MinIO no usa regiones
    endpoint: options.endpoint, // URL del MinIO en Railway
    forcePathStyle: true,       // CRITICO para MinIO (sin esto devuelve 301)
})
```

---

## API / Interfaces

### Upload

`POST /admin/uploads` — endpoint standard de Medusa, customizado para agregar phantom prefix.

El upload endpoint lee el header `x-upload-context` y prepende el prefix correspondiente al filename antes de pasarlo a `smart-storage`.

### Media Library

`GET /admin/media?prefix=&search=&continuationToken=`

Implementado en `src/api/admin/media/route.ts` usando `ListObjectsV2Command`:

```typescript
// Paginacion normal (sin search): MaxKeys 100, usa Delimiter "/" para carpetas
// Con search: fetcha todas las paginas (MaxKeys 1000) y filtra por nombre en memoria
```

Respuesta:
```json
{
  "folders": [{ "id": "products/", "name": "products", "type": "folder" }],
  "files": [{
    "id": "products/photo-1234567890.jpg",
    "url": "https://bucket.railway.app/medusa-media/products/photo-1234567890.jpg",
    "name": "photo-1234567890.jpg",
    "key": "products/photo-1234567890.jpg",
    "size": 45678,
    "type": "file",
    "last_modified": "2026-01-15T10:30:00Z"
  }],
  "prefix": "",
  "count": 2,
  "isTruncated": false,
  "nextContinuationToken": null
}
```

### Metodo uploadProtected

El servicio expone `uploadProtected()` para archivos privados que se guardan en `protected/` sin `ACL: "public-read"`. Las URLs se generan con `getSignedUrl()` (expiran en 3600s).

---

## Variables de Entorno

```bash
MINIO_ENDPOINT=https://bucket-production-2e09.up.railway.app
MINIO_ACCESS_KEY=your_access_key
MINIO_SECRET_KEY=your_secret_key
MINIO_BUCKET=medusa-media
```

La URL publica de un archivo sigue el formato: `MINIO_ENDPOINT/MINIO_BUCKET/folder/filename-timestamp.ext`

---

## Reglas Criticas

- `smart-storage` es el provider activo — no `@medusajs/file-s3` (el plugin es legacy)
- `forcePathStyle: true` es obligatorio para MinIO (sin esto falla con 301 redirect)
- `region: "us-east-1"` es requerido por el AWS SDK aunque MinIO no use regiones reales
- Para categorias: siempre usar direct fetch con header explicito, no el SDK de Medusa
- La image URL de categorias se guarda en `product_category.metadata.image.url`
- El bucket `medusa-media` debe tener politica de acceso publico para lectura
- Usar `credentials: "include"` en fetch del Admin UI (auth por cookie de sesion)

---

## Archivos Clave

| Tipo | Ruta Completa | Proposito |
|------|---------------|-----------|
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/smart-storage/service.ts` | S3 upload con folder routing |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/smart-storage/index.ts` | Definicion del modulo |
| API | `/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/media/route.ts` | Listado paginado con server-side search |
| Config | `/home/alejo/webapps/ecopowertech-workspace/backend/medusa-config.ts` | Registro en modules[] y plugins[] |

---

## Troubleshooting

**Imagenes van a `content/` en lugar de `products/`**
- Verificar que el widget upload-context-interceptor este en las zones correctas
- Network tab: verificar que se envia header `x-upload-context`

**Upload stuck en loading**
- Verificar credentials MinIO en `.env`
- Testear: `curl $MINIO_ENDPOINT/$MINIO_BUCKET/`
- Verificar que el bucket tenga write access

**"Unauthorized" en /admin/media**
- La route debe exportar `export const GET = async (req, res)` (named export)
- Medusa aplica auth automaticamente a rutas `/admin/*` con named exports

**Imagenes no se muestran (broken links)**
- Verificar que `file_url` en config tiene formato `ENDPOINT/BUCKET`
- Verificar politica publica de lectura en el bucket MinIO

**0-byte files**
- Verificar que el `Body` del `PutObjectCommand` recibe el Buffer correcto
- Verificar que Multer esta configurado con `storage: memoryStorage()`

---

## Historial de Decisiones

- **smart-storage custom vs @medusajs/file-s3**: El modulo oficial no soporta folder routing. El modulo custom intercepta el filename antes de subir e implementa logica de phantom prefix para organizar archivos automaticamente.
- **Direct fetch para categorias**: El SDK de Medusa no permite pasar headers custom. Las categorias necesitan `x-upload-context: categories` explicito — el widget usa `fetch()` nativo con `credentials: "include"`.
- **Phantom prefix**: El upload workflow de Medusa pasa el filename pero no el header HTTP original. El prefix en el filename es la forma de pasar el contexto a traves del workflow sin modificar el core.
- **MinIO en Railway vs servicio externo**: Menor latencia al estar en el mismo proyecto Railway. Sin costo adicional de transferencia intra-proyecto.
