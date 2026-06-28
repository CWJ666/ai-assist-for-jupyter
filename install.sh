#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Classic Jupyter Notebook ──────────────────────────────────────────────────
install_classic() {
  echo "→ Installing for classic Jupyter Notebook..."
  jupyter nbextension install "$DIR/nbextension" --user --overwrite --destination=rb_extension
  jupyter nbextension enable rb_extension/main --user
  echo "  ✓ Classic extension installed"
}

# ── JupyterLab ────────────────────────────────────────────────────────────────
install_lab() {
  echo "→ Building JupyterLab extension (requires Node.js)..."
  cd "$DIR/labextension"
  if ! command -v node &>/dev/null; then
    echo "  ✗ Node.js not found. Skipping JupyterLab extension."
    echo "    Install Node.js 18+ and re-run this script."
    return
  fi
  jlpm install
  jlpm build:prod
  pip install -e .
  jupyter labextension develop . --overwrite
  echo "  ✓ JupyterLab extension installed"
  cd "$DIR"
}

# ── Auto-detect or use argument ───────────────────────────────────────────────
if [ "$1" = "classic" ]; then
  install_classic
elif [ "$1" = "lab" ]; then
  install_lab
else
  # Install both if possible
  install_classic
  install_lab
fi

echo ""
echo "Done! Refresh your browser to see the 🤖 button."
