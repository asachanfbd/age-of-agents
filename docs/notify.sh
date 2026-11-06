#!/bin/bash

# Ensure a message argument is provided
if [ -z "$1" ]; then
  echo "Usage: $0 \"<message argument here>\""
  exit 1
fi

MESSAGE="$1"
# Path to the .env file in the same directory (docs/.env)
ENV_FILE="$(dirname "$0")/.env"

# Check if .env exists
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi

# Load variables from .env
export $(grep -v '^#' "$ENV_FILE" | xargs)

# Verify required variables are set
if [ -z "$SEND_HOST" ] || [ -z "$SEND_API_KEY" ] || [ -z "$SEND_TO" ]; then
  echo "Error: SEND_HOST, SEND_API_KEY, or SEND_TO is not set in $ENV_FILE"
  exit 1
fi

# Run the curl command
curl -s --url "${SEND_HOST}/api/send" \
  -H "x-api-key: ${SEND_API_KEY}" \
  --data-raw "{\"to\":\"${SEND_TO}\",\"message\":\"${MESSAGE}\"}"

echo ""
