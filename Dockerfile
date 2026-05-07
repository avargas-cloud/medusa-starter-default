FROM node:20.20.2-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g yarn@1.22.22

COPY package.json yarn.lock ./
COPY patches ./patches

RUN yarn install --frozen-lockfile

COPY . .

ENV RAILWAY_ENVIRONMENT=production
RUN yarn build

FROM node:20.20.2-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=builder /app/.medusa/server ./

CMD ["npm", "start"]
