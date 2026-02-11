# Instalación Local Completa - Ecopowertech Backend

Guía paso a paso para instalar el backend de Ecopowertech en tu máquina local.

## Requisitos Previos

- Ubuntu/Debian Linux (o WSL2 en Windows)
- Acceso a sudo/root
- Conexión a internet

---

## 1. Instalar Node.js y Yarn

```bash
# Instalar Node.js v20.x (LTS recomendado)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verificar instalación
node --version  # Debe mostrar v20.x.x
npm --version

# Instalar Yarn
npm install -g yarn
yarn --version
```

---

## 2. Instalar PostgreSQL

```bash
# Instalar PostgreSQL 15+
sudo apt update
sudo apt install postgresql postgresql-contrib -y

# Iniciar servicio
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Crear usuario y base de datos
sudo -u postgres psql << EOF
CREATE USER postgres WITH PASSWORD 'password';
ALTER USER postgres WITH SUPERUSER;
CREATE DATABASE ecopowertech_dev;
GRANT ALL PRIVILEGES ON DATABASE ecopowertech_dev TO postgres;
\q
EOF

# Verificar conexión
psql -U postgres -d ecopowertech_dev -c "SELECT version();"
```

**Credenciales creadas:**
- Usuario: `postgres`
- Password: `password`
- Base de datos: `ecopowertech_dev`

---

## 3. Instalar Redis

```bash
# Instalar Redis
sudo apt install redis-server -y

# Configurar Redis para usar systemd
sudo sed -i 's/^supervised no/supervised systemd/' /etc/redis/redis.conf

# Iniciar servicio
sudo systemctl restart redis-server
sudo systemctl enable redis-server

# Verificar instalación
redis-cli ping  # Debe responder "PONG"
```

**Redis URL:** `redis://localhost:6379`

---

## 4. Instalar Meilisearch

```bash
# Descargar e instalar Meilisearch
curl -L https://install.meilisearch.com | sh

# Mover a directorio de binarios
sudo mv meilisearch /usr/local/bin/

# Crear servicio systemd
sudo tee /etc/systemd/system/meilisearch.service > /dev/null << 'EOF'
[Unit]
Description=Meilisearch
After=network.target

[Service]
Type=simple
User=meilisearch
Group=meilisearch
ExecStart=/usr/local/bin/meilisearch --http-addr 127.0.0.1:7700 --master-key masterKey
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

# Crear usuario para Meilisearch
sudo useradd -r -s /bin/false meilisearch

# Iniciar servicio
sudo systemctl daemon-reload
sudo systemctl start meilisearch
sudo systemctl enable meilisearch

# Verificar instalación
curl http://localhost:7700/health
# Debe responder: {"status":"available"}
```

**Meilisearch config:**
- URL: `http://localhost:7700`
- Master Key: `masterKey`

---

## 5. Clonar e Instalar el Proyecto

```bash
# Navegar a carpeta de trabajo
cd ~/Webapps  # O donde prefieras

# Clonar repositorio (ajusta la URL según tu repo)
git clone <TU_REPO_URL> ecopowertech-workspace
cd ecopowertech-workspace

# Instalar dependencias del backend
cd backend
yarn install

# Volver a raíz del proyecto
cd ..
```

---

## 6. Configurar Variables de Entorno

```bash
# En el directorio raíz del proyecto
cd backend

# El archivo .env.local ya existe, verificar que tenga:
cat .env.local
```

Debe contener:

```env
# Environment: LOCAL
PORT=9000
STORE_URL=http://localhost:4321

# -----------------------------------------------------------------------------
# DATABASE - LOCAL
# -----------------------------------------------------------------------------
DATABASE_URL=postgresql://postgres:password@localhost:5432/ecopowertech_dev

# -----------------------------------------------------------------------------
# REDIS - LOCAL
# -----------------------------------------------------------------------------
REDIS_URL=redis://localhost:6379

# -----------------------------------------------------------------------------
# MEILISEARCH - LOCAL
# -----------------------------------------------------------------------------
MEILISEARCH_HOST=http://localhost:7700
MEILISEARCH_API_KEY=masterKey
VITE_MEILISEARCH_HOST=http://localhost:7700
VITE_MEILISEARCH_API_KEY=masterKey

# -----------------------------------------------------------------------------
# FILE STORAGE (MinIO / S3) - RAILWAY
# -----------------------------------------------------------------------------
# Nota: Para almacenamiento local de imágenes, necesitarías instalar MinIO
# Por ahora, las imágenes se sirven desde Railway MinIO
MINIO_ENDPOINT=https://bucket-production-2e09.up.railway.app
MINIO_ACCESS_KEY=xvyYtNjjihzWeLodFtfN4UYEdNtMJKTk
MINIO_SECRET_KEY=HQ2pjxOg5ISSiVwcogdUwnqSbxr87PgNbMLxwiUcrcRVUxv2
MINIO_BUCKET=medusa-media

# -----------------------------------------------------------------------------
# ADMIN & AUTH SECRETS
# -----------------------------------------------------------------------------
JWT_SECRET=supersecret
COOKIE_SECRET=supersecret
ADMIN_CORS=http://localhost:9000,http://localhost:5173
STORE_CORS=http://localhost:4321,http://localhost:8000

# -----------------------------------------------------------------------------
# GOOGLE OAUTH (Opcional)
# -----------------------------------------------------------------------------
# GOOGLE_CLIENT_ID=tu_client_id
# GOOGLE_CLIENT_SECRET=tu_client_secret
# GOOGLE_CALLBACK_URL=http://localhost:9000/auth/customer/google/callback

# -----------------------------------------------------------------------------
# SENDGRID (Opcional - para emails)
# -----------------------------------------------------------------------------
# SENDGRID_API_KEY=tu_api_key
# SENDGRID_FROM=noreply@ecopowertech.com
```

---

## 7. Inicializar Base de Datos

```bash
# Asegurarse de estar en backend/
cd ~/Webapps/ecopowertech-workspace/backend

# Activar configuración local
../switch-db local

# Correr migraciones
npx medusa db:migrate

# (Opcional) Crear usuario admin
npx medusa user -e admin@medusa-test.com -p supersecret

# (Opcional) Seed database con datos de prueba
# Esto solo si quieres datos de prueba iniciales
# npx medusa seed
```

---

## 8. Sincronizar Datos desde Railway (Opcional)

Si quieres trabajar con los datos reales de Railway:

```bash
# Descargar datos de Railway a local
./backend/scripts/db/sync-railway-to-local.sh

# Esto sincroniza:
# - PostgreSQL (productos, clientes, órdenes, etc.)
# - Meilisearch (índices de búsqueda)
```

---

## 9. Iniciar el Backend

```bash
# Desde la raíz del proyecto
./back

# O manualmente:
cd backend
yarn dev
```

Deberías ver:

```
✔ Server is ready on port: 9000 – 2400ms
info:    Admin URL → http://localhost:9000/app
```

---

## 10. Verificar Instalación

### Backend Health Check
```bash
curl http://localhost:9000/health
# Debe responder: OK
```

### Admin Dashboard
Abre en tu navegador: `http://localhost:9000/app`

- Usuario: `admin@medusa-test.com`
- Password: `supersecret`

### Servicios Locales

```bash
# PostgreSQL
psql -U postgres -d ecopowertech_dev -c "SELECT count(*) FROM product;"

# Redis
redis-cli ping

# Meilisearch
curl http://localhost:7700/health
```

---

## 11. Scripts Útiles

Desde la raíz del proyecto:

```bash
# Iniciar backend
./back

# Detener backend
./stop-back

# Cambiar a base de datos local
./switch-db local

# Cambiar a base de datos Railway
./switch-db railway

# Ver estado actual
./switch-db status

# Sincronizar Railway → Local
./backend/scripts/db/sync-railway-to-local.sh

# Sincronizar Local → Railway (CUIDADO!)
./backend/scripts/db/sync-local-to-railway.sh
```

---

## Troubleshooting

### PostgreSQL no arranca

```bash
# Ver logs
sudo journalctl -u postgresql -n 50

# Reiniciar servicio
sudo systemctl restart postgresql
```

### Redis no conecta

```bash
# Verificar servicio
sudo systemctl status redis-server

# Reiniciar
sudo systemctl restart redis-server
```

### Meilisearch no responde

```bash
# Ver logs
sudo journalctl -u meilisearch -n 50

# Reiniciar
sudo systemctl restart meilisearch
```

### Backend no arranca

```bash
# Verificar que todos los servicios estén corriendo
sudo systemctl status postgresql
sudo systemctl status redis-server  
sudo systemctl status meilisearch

# Limpiar node_modules y reinstalar
cd backend
rm -rf node_modules
yarn install
```

---

## Configuración Adicional (Opcional)

### Instalar MinIO Local

Si quieres almacenar imágenes localmente en lugar de usar Railway MinIO:

```bash
# Descargar MinIO
wget https://dl.min.io/server/minio/release/linux-amd64/minio
chmod +x minio
sudo mv minio /usr/local/bin/

# Crear directorio de datos
sudo mkdir -p /var/lib/minio
sudo chown -R $(whoami) /var/lib/minio

# Crear servicio
sudo tee /etc/systemd/system/minio.service > /dev/null << 'EOF'
[Unit]
Description=MinIO
After=network.target

[Service]
Type=simple
User=$(whoami)
ExecStart=/usr/local/bin/minio server /var/lib/minio --console-address ":9001"
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

# Iniciar servicio
sudo systemctl daemon-reload
sudo systemctl start minio
sudo systemctl enable minio
```

Luego actualiza `.env.local`:
```env
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=medusa-media
```

---

## Resumen de Puertos

| Servicio | Puerto | URL |
|----------|--------|-----|
| Backend (Medusa) | 9000 | http://localhost:9000 |
| Admin Dashboard | 9000 | http://localhost:9000/app |
| PostgreSQL | 5432 | localhost:5432 |
| Redis | 6379 | localhost:6379 |
| Meilisearch | 7700 | http://localhost:7700 |
| MinIO (opcional) | 9000 | http://localhost:9000 |
| MinIO Console (opcional) | 9001 | http://localhost:9001 |

---

## Próximos Pasos

1. ✅ Backend local funcionando
2. Instalar y configurar frontend (si aplica)
3. Conectar frontend a backend local
4. Desarrollo y pruebas locales
5. Cuando estés listo, push a Railway

## Documentación Adicional

- [railway-startup-optimization.md](railway-startup-optimization.md) - Troubleshooting startup issues
- [SETUP.md](SETUP.md) - Setup original (puede tener info adicional)
- [QUICKSTART.md](QUICKSTART.md) - Quick start guide

---

**¡Listo para desarrollar! 🚀**
