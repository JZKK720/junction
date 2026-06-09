#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────
# compile-and-install.sh
# Builds Junction and installs it straight into
# ~/.vscode/extensions/ under the loaded extension id.
# ────────────────────────────────────────────────────────

cd "$(dirname "$0")"

EXT_NAME="Plaer1.junction"
EXT_DIR="$HOME/.vscode/extensions/${EXT_NAME}"

echo "🔧 Building Junction..."
npm run build

# Remove stale installs from the pre-rebrand identity so VS Code can't load an
# old build instead of this one (the dup-folder trap that hid earlier rebuilds).
echo "🧹 Removing stale pre-rebrand installs"
code --uninstall-extension owenliuyuxuan.agent-bridge-vscode >/dev/null 2>&1 || true
code --uninstall-extension OwenLiuyuxuan.openclaw-vscode >/dev/null 2>&1 || true
rm -rf "$HOME/.vscode/extensions/OwenLiuyuxuan.openclaw-vscode" \
       "$HOME/.vscode/extensions/owenliuyuxuan.agent-bridge-vscode-0.2.0" 2>/dev/null || true

echo "📦 Installing to ${EXT_DIR}"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"

# Core files the extension needs at runtime.
# package.json "main" is ./dist/extension.js, so the bundle must live in dist/.
mkdir -p "$EXT_DIR/dist"
cp dist/extension.js dist/extension.js.map "$EXT_DIR/dist/"
cp package.json "$EXT_DIR/"
cp -r resources "$EXT_DIR/"

# Production-only node_modules (exclude dev deps like typescript, esbuild)
mkdir -p "$EXT_DIR/node_modules"
for mod in ws markdown-it; do
  if [ -d "node_modules/$mod" ]; then
    cp -r "node_modules/$mod" "$EXT_DIR/node_modules/"
  fi
done

echo "✅ Installed to ${EXT_DIR}"
echo ""
echo "Reload VSCode now:   Ctrl+Shift+P → Developer: Reload Window"
echo "Verify install:      code --list-extensions | grep -i junction"
echo ""
echo "⚠️  After future rebuilds: re-run this script + Reload Window to pick up changes."
