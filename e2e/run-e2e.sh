#!/bin/bash
#
# E2E Test Runner Script
#
# This script manages the server lifecycle and runs E2E tests.
# Usage: ./e2e/run-e2e.sh [--headed] [--keep-server]
#
# Requirements:
#   - agent-browser 0.6.0 (screenshot broken in 0.7.x)
#     Install: npm install -g agent-browser@0.6.0
#
# Options:
#   --headed      Run browser in headed mode (visible)
#   --keep-server Don't stop the server after tests

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

HEADED=""
KEEP_SERVER=""
SERVER_PID=""
FRONTEND_PID=""

# Parse arguments
for arg in "$@"; do
  case $arg in
    --headed)
      HEADED="--headed"
      ;;
    --keep-server)
      KEEP_SERVER="1"
      ;;
  esac
done

cleanup() {
  echo ""
  echo "Cleaning up..."

  if [ -z "$KEEP_SERVER" ]; then
    if [ -n "$SERVER_PID" ]; then
      echo "Stopping backend server (PID: $SERVER_PID)..."
      kill $SERVER_PID 2>/dev/null || true
    fi
    if [ -n "$FRONTEND_PID" ]; then
      echo "Stopping frontend server (PID: $FRONTEND_PID)..."
      kill $FRONTEND_PID 2>/dev/null || true
    fi
  else
    echo "Keeping servers running (--keep-server specified)"
    echo "  Backend PID: $SERVER_PID"
    echo "  Frontend PID: $FRONTEND_PID"
  fi
}

trap cleanup EXIT

# Check if servers are already running
check_port() {
  nc -z localhost $1 2>/dev/null
  return $?
}

wait_for_server() {
  local port=$1
  local name=$2
  local max_attempts=60
  local attempt=0

  echo "Waiting for $name on port $port..."

  while ! check_port $port; do
    attempt=$((attempt + 1))
    if [ $attempt -ge $max_attempts ]; then
      echo "ERROR: $name failed to start after $max_attempts attempts"
      exit 1
    fi
    sleep 1
  done

  echo "$name is ready on port $port"
}

# Check if servers are already running
BACKEND_PORT="${BACKEND_PORT:-4096}"
FRONTEND_PORT="${FRONTEND_PORT:-8888}"

if check_port $BACKEND_PORT && check_port $FRONTEND_PORT; then
  echo "Servers already running on ports $BACKEND_PORT and $FRONTEND_PORT"
  echo "Using existing servers for tests"
else
  echo "Starting servers using dev.sh..."
  cd "$PROJECT_DIR"

  # Source nvm if available
  export NVM_DIR="$HOME/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    source "$NVM_DIR/nvm.sh"
    nvm use 22 --silent 2>/dev/null || true
  fi

  # Start backend
  echo "Starting backend server on port $BACKEND_PORT..."
  OPENCODE_PERMISSION='{"*":"allow"}' \
  bun run --cwd packages/opencode --conditions=browser src/index.ts serve \
    --hostname "0.0.0.0" \
    --port "$BACKEND_PORT" &
  SERVER_PID=$!

  # Start frontend
  echo "Starting frontend server on port $FRONTEND_PORT..."
  VITE_OPENCODE_SERVER_HOST="${VITE_OPENCODE_SERVER_HOST:-localhost}" \
  VITE_OPENCODE_SERVER_PORT="$BACKEND_PORT" \
  bun run --cwd packages/app dev -- --host "0.0.0.0" --port "$FRONTEND_PORT" &
  FRONTEND_PID=$!

  # Wait for servers to be ready
  wait_for_server $BACKEND_PORT "Backend"
  wait_for_server $FRONTEND_PORT "Frontend"

  # Give Vite a moment to fully initialize
  sleep 2
fi

# Set environment for tests
export E2E_BASE_URL="http://localhost:$FRONTEND_PORT"
export AGENT_BROWSER_ARGS="--no-sandbox"

if [ -n "$HEADED" ]; then
  export AGENT_BROWSER_HEADED="1"
fi

# Create screenshots directory
mkdir -p /tmp/e2e-screenshots

echo ""
echo "=== Running E2E Tests ==="
echo "Base URL: $E2E_BASE_URL"
echo ""

# Run the tests
cd "$PROJECT_DIR"
bun run e2e/runner.ts

TEST_EXIT_CODE=$?

echo ""
echo "Screenshots saved to: /tmp/e2e-screenshots/"
echo ""

exit $TEST_EXIT_CODE
