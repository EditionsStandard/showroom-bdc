#!/bin/bash
# Double-cliquez sur ce fichier pour démarrer l'application

cd "$(dirname "$0")"

# Load nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
command -v nvm &>/dev/null && nvm use 20 --silent 2>/dev/null

# Check Node.js
if ! command -v node &> /dev/null; then
  osascript -e 'display alert "Node.js non installé" message "Veuillez installer Node.js depuis nodejs.org puis relancer ce fichier." as critical'
  open "https://nodejs.org/fr/"
  exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installation des dépendances (première fois)..."
  npm install
fi

# Get local IP
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")

echo ""
echo "========================================"
echo "  Showroom Durand — Démarrage"
echo "========================================"
echo "  Admin local : http://localhost:3000/admin"
echo "  Sur votre réseau Wi-Fi : http://$IP:3000"
echo "  (utilisez cette IP pour les QR codes)"
echo "========================================"
echo ""

# Open browser after 1.5s
(sleep 1.5 && open "http://localhost:3000/admin") &

node server.js
