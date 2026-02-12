#!/bin/bash
# Deep clean and reinstall script

cd /home/alejo/Webapp/ecopowertech-workspace/backend

echo "🗑️  Removing node_modules..."
rm -rf node_modules

echo "🗑️  Removing .medusa cache..."
rm -rf .medusa

echo "🗑️  Removing dist..."
rm -rf dist

echo "✅ Cleanup complete!"
echo ""
echo "📦 Reinstalling dependencies..."
yarn install

echo "✅ Reinstall complete!"
