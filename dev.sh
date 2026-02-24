#!/bin/bash

# Development script to run both backend and frontend servers
# Backend: opencode server on 0.0.0.0:4096
# Frontend: vite dev server on 0.0.0.0:8888

set -e

# Load nvm and switch to Node 22 (required for Vite)
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    source "$NVM_DIR/nvm.sh"
    nvm use 22 --silent || {
        echo "Node 22 not installed. Installing..."
        nvm install 22
        nvm use 22
    }
    echo "Using Node $(node --version)"
fi

OC_PASS_FILE="$HOME/.oc-pass.json"
if [ -f "$OC_PASS_FILE" ]; then
    OPENCODE_SERVER_PASSWORD=$(bun -e "const f=require('fs');const j=JSON.parse(f.readFileSync('$OC_PASS_FILE','utf8'));process.stdout.write(j.password??'')")
    export OPENCODE_SERVER_PASSWORD
fi

BACKEND_HOST="${BACKEND_HOST:-0.0.0.0}"
BACKEND_PORT="${BACKEND_PORT:-4096}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
FRONTEND_PORT="${FRONTEND_PORT:-8888}"

cleanup() {
    echo "Shutting down servers..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

echo "Starting backend server on $BACKEND_HOST:$BACKEND_PORT..."
OPENCODE_PERMISSION='{"*":"allow"}' \
OPENCODE_ENABLE_EXA=true \
bun run --cwd packages/opencode --conditions=browser src/index.ts serve \
    --hostname "$BACKEND_HOST" \
    --port "$BACKEND_PORT" \
    --cors "http://$FRONTEND_HOST:$FRONTEND_PORT" \
    --cors "http://localhost:$FRONTEND_PORT" &
BACKEND_PID=$!

echo "Starting frontend server on $FRONTEND_HOST:$FRONTEND_PORT..."
# Use localhost for browser connection (backend listens on 0.0.0.0 but browser connects via localhost)
VITE_OPENCODE_SERVER_HOST="${VITE_OPENCODE_SERVER_HOST:-localhost}" \
VITE_OPENCODE_SERVER_PORT="$BACKEND_PORT" \
bun run --cwd packages/app dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT" &
FRONTEND_PID=$!

echo ""
echo "Backend:  http://$BACKEND_HOST:$BACKEND_PORT"
echo "Frontend: http://$FRONTEND_HOST:$FRONTEND_PORT"
echo ""
echo "Press Ctrl+C to stop both servers"

wait
