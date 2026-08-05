#!/bin/sh
# Launch wrapper so the preview harness can start Vite even though Node lives at
# ~/.local/node/bin (not on the default PATH on this machine).
export PATH="$HOME/.local/node/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
exec node node_modules/vite/bin/vite.js --port "${PORT:-5173}" --strictPort "$@"
