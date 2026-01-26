#!/bin/bash

# setup.sh - Universal Setup Script for Local/Work PC
# Usage: ./setup.sh

set -e

echo "🚀 Starting Project Setup..."

# 0. Kill any existing Medusa processes (clean slate)
echo "🧹 Cleaning up old processes..."
pkill -9 -f "node.*medusa" 2>/dev/null || true
pkill -9 -f "meilisearch" 2>/dev/null || true

# 1. Check Node.js Version
NODE_VERSION=$(node -v)
echo "📦 Node.js Version: $NODE_VERSION"
if [[ "$NODE_VERSION" != v20* ]]; then
    echo "⚠️  WARNING: It is recommended to use Node.js v20.x. You are using $NODE_VERSION."
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# 2. Check/Install Yarn
if ! command -v yarn &> /dev/null; then
    echo "📦 Yarn not found. Installing global yarn..."
    npm install -g yarn
else
    echo "✅ Yarn is installed."
fi

# 3. Install Dependencies
echo "📦 Installing project dependencies..."
yarn install

# 4. Setup Local MeiliSearch (for development only)
if [ ! -d "bin" ]; then
    mkdir -p bin
fi

if [ ! -f "bin/meilisearch" ]; then
    echo "🔍 Local MeiliSearch binary not found. Downloading..."
    # Download script for Linux/Mac (adjust if Windows Git Bash needs .exe)
    curl -L https://install.meilisearch.com | sh
    mv meilisearch bin/meilisearch
    chmod +x bin/meilisearch
    echo "✅ MeiliSearch downloaded to bin/meilisearch"
else
    echo "✅ Local MeiliSearch binary found."
fi

# 5. Env File Setup
if [ ! -f ".env" ]; then
    echo "📝 .env file not found."
    if [ -f ".env.template" ]; then
        echo "Creating .env from .env.template..."
        cp .env.template .env
        echo "⚠️  PLEASE UPDATE .env WITH YOUR KEYS!"
    else
        echo "❌ No .env.template found. You'll need to create .env manually."
    fi
else
    echo "✅ .env file exists."
fi

# 6. Clean old cache/build artifacts
echo "🧹 Cleaning old build artifacts..."
rm -rf .medusa/server 2>/dev/null || true
rm -rf dist 2>/dev/null || true

echo ""
echo "🎉 Setup Complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Next steps:"
echo "  1. Update .env if needed (DATABASE_URL, REDIS_URL, etc)"
echo "  2. Run: ./dev.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
