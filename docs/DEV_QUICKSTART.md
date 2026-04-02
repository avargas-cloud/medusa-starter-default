# Dev — Quickstart Local
> **Tipo**: Operational Guide
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que hace esta guia

Guia unificada para instalar y ejecutar el backend de EcoPowerTech en una maquina nueva. Desde cero hasta servidor corriendo en `http://localhost:9000`.

**Opcion rapida**: Conectar a Railway DB (sin instalar PostgreSQL/Redis local).
**Opcion completa**: Instalar todos los servicios localmente.

---

## Prerequisitos

- Ubuntu/Debian Linux o WSL2 en Windows
- Node.js v20+ via NVM (ver Paso 1)
- Git configurado

---

## Instalacion Completa (maquina nueva)

### Paso 1 — Node.js v20 con NVM

```bash
# Instalar NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Activar NVM en sesion actual
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Persistencia en ~/.bashrc
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc
echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> ~/.bashrc

# Instalar Node 20
nvm install 20
nvm alias default 20

# Verificar (debe mostrar ~/.nvm/..., NO /mnt/c/ en WSL)
node --version  # v20.x.x
which node
```

### Paso 2 — Yarn

```bash
npm install -g yarn
yarn --version  # 1.22.x
```

### Paso 3 — PostgreSQL (si instalacion local)

```bash
sudo apt update && sudo apt install postgresql postgresql-contrib -y
sudo systemctl start postgresql && sudo systemctl enable postgresql

sudo -u postgres psql << EOF
CREATE USER postgres WITH PASSWORD 'password';
ALTER USER postgres WITH SUPERUSER;
CREATE DATABASE ecopowertech_dev;
GRANT ALL PRIVILEGES ON DATABASE ecopowertech_dev TO postgres;
\q
EOF

# Verificar
psql -U postgres -d ecopowertech_dev -c "SELECT version();"
```

Credenciales locales: usuario `postgres`, password `password`, DB `ecopowertech_dev`

### Paso 4 — Redis (si instalacion local)

```bash
sudo apt install redis-server -y
sudo sed -i 's/^supervised no/supervised systemd/' /etc/redis/redis.conf
sudo systemctl restart redis-server && sudo systemctl enable redis-server

redis-cli ping  # PONG
```

### Paso 5 — Meilisearch (si instalacion local)

```bash
curl -L https://install.meilisearch.com | sh
sudo mv meilisearch /usr/local/bin/

sudo useradd -r -s /bin/false meilisearch

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

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload && sudo systemctl start meilisearch && sudo systemctl enable meilisearch
curl http://localhost:7700/health  # {"status":"available"}
```

### Paso 6 — Clonar el proyecto

```bash
cd ~/webapps
git clone <REPO_URL> ecopowertech-workspace
cd ecopowertech-workspace/backend
yarn install
```

### Paso 7 — Variables de entorno

El archivo `.env.local` ya existe. Verificar que contiene (adaptar segun si usas local o Railway):

```env
# DB local
DATABASE_URL=postgresql://postgres:password@localhost:5432/ecopowertech_dev
REDIS_URL=redis://localhost:6379
MEILISEARCH_HOST=http://localhost:7700
MEILISEARCH_API_KEY=masterKey

# Secrets (para dev son suficientes estos valores)
JWT_SECRET=supersecret
COOKIE_SECRET=supersecret

# CORS para dev
STORE_CORS=http://localhost:4321,http://localhost:3001
ADMIN_CORS=http://localhost:9000,http://localhost:5173
AUTH_CORS=http://localhost:4321,http://localhost:5173,http://localhost:3001

# MinIO — usar el de Railway para imagenes (no instalar local por defecto)
MINIO_ENDPOINT=https://bucket-production-2e09.up.railway.app
MINIO_ACCESS_KEY=<ver .env.railway>
MINIO_SECRET_KEY=<ver .env.railway>
MINIO_BUCKET=medusa-media
```

Activar la configuracion local:
```bash
../switch-db local
```

### Paso 8 — Inicializar base de datos

```bash
# Desde backend/
npx medusa db:migrate

# Crear usuario admin
npx medusa user -e admin@ecopowertech.com -p supersecret
```

### Paso 9 — Opcional: Sincronizar datos desde Railway

```bash
cd ..
./sync-db pull  # Railway → Local
```

### Paso 10 — Iniciar el servidor

```bash
# Desde la raiz del workspace (abre tmux session "medusa-dev")
./back

# O manualmente:
cd backend && yarn dev
```

Startup esperado: ~2.4 segundos
```
WORKER_MODE: shared
Server is ready on port: 9000
```

---

## Opcion Rapida — Conectar a Railway DB

Si no quieres instalar PostgreSQL/Redis/Meilisearch localmente:

```bash
cd ecopowertech-workspace/backend
../switch-db railway   # usa .env.railway
./back
```

Startup: ~4.4 segundos (latencia de red). Mismo comportamiento que produccion.

---

## Comandos del Dia a Dia

```bash
yarn dev          # Dev server (nodemon + medusa develop) → puerto 9000
yarn build        # Production build
yarn start        # Production server
yarn type-check   # TypeScript check
yarn lint         # ESLint
yarn lint:fix     # ESLint auto-fix
yarn format       # Prettier
yarn code-quality # type-check + lint + format:check
yarn seed         # Seed base de datos
yarn sync:meili   # Force Meilisearch sync
yarn test:unit    # Unit tests
```

---

## Scripts de Infraestructura (raiz del workspace)

```bash
./back            # Inicia backend en tmux session "medusa-dev"
./switch-db local   # Usa PostgreSQL/Redis/Meilisearch locales
./switch-db railway # Usa servicios de Railway
./switch-db status  # Muestra cual esta activo
./sync-db pull    # Railway → Local (copia datos, seguro)
./sync-db push    # Local → Railway (PELIGROSO — triple confirmacion)
```

Ver logs del backend:
```bash
tmux capture-pane -t medusa-dev -p -S -50
```

---

## Puertos Locales

| Servicio | Puerto |
|----------|--------|
| Backend (Medusa) | 9000 |
| Admin Panel | 9000/app |
| PostgreSQL | 5432 |
| Redis | 6379 |
| Meilisearch | 7700 |
| Frontend (Astro) | 4321 |
| POS (Next.js) | 3001 |

---

## MinIO Local (opcional)

Si necesitas almacenamiento local en lugar de Railway MinIO:

```bash
wget https://dl.min.io/server/minio/release/linux-amd64/minio
chmod +x minio && sudo mv minio /usr/local/bin/
sudo mkdir -p /var/lib/minio && sudo chown -R $(whoami) /var/lib/minio
# Cambiar al puerto 9001 para no conflicto con Medusa (que usa 9000)
minio server /var/lib/minio --address ":9001" --console-address ":9002"
```

En `.env.local`:
```env
MINIO_ENDPOINT=http://localhost:9001
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=medusa-media
```

---

## Troubleshooting

**"command not found: node"**
```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 20
```

**"command not found: yarn"**
```bash
npm install -g yarn
```

**PostgreSQL no arranca**
```bash
sudo journalctl -u postgresql -n 50
sudo systemctl restart postgresql
```

**Redis no conecta**
```bash
sudo systemctl status redis-server
sudo systemctl restart redis-server
redis-cli ping  # Debe retornar PONG
```

**Meilisearch no responde**
```bash
sudo journalctl -u meilisearch -n 50
sudo systemctl restart meilisearch
curl http://localhost:7700/health
```

**Backend no arranca — "Cannot find module"**
```bash
cd backend && rm -rf node_modules && yarn install
```

**Backend no arranca — error de DB**
```bash
cat backend/.env | grep DATABASE_URL
psql -U postgres -d ecopowertech_dev -c "SELECT 1"
```

**Build falla con errores de TypeScript**
```bash
rm -rf backend/node_modules backend/.medusa
cd backend && yarn install && yarn build
```

**Startup muy lento en Ubuntu nativo (>60s)**

Problema de DNS con `systemd-resolved`. Ver `DEPLOY_PERFORMANCE.md` para el fix.

---

## Reglas Importantes

- SIEMPRE usar `yarn`, NUNCA `npm install` (bloqueado por `.npmrc`)
- En WSL: proyecto DEBE estar en el filesystem de Linux (`/home/...`), NO en `/mnt/c/`
- El `.env` activo es el que `switch-db` copia — no editar directamente, editar `.env.local` o `.env.railway`

---

## Archivos Clave

| Tipo | Ruta Completa | Proposito |
|------|---------------|-----------|
| Script | `/home/alejo/webapps/ecopowertech-workspace/back` | Iniciar backend (tmux) |
| Script | `/home/alejo/webapps/ecopowertech-workspace/switch-db` | Cambiar entre local/railway |
| Script | `/home/alejo/webapps/ecopowertech-workspace/sync-db` | Sincronizar datos con Railway |
| Env | `/home/alejo/webapps/ecopowertech-workspace/backend/.env.local` | Variables para desarrollo local |
| Env | `/home/alejo/webapps/ecopowertech-workspace/backend/.env.railway` | Variables para Railway |
| Config | `/home/alejo/webapps/ecopowertech-workspace/backend/medusa-config.ts` | Configuracion del servidor |
