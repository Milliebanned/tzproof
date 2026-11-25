#!/bin/sh
# Sign Kane in from Fly secrets (fly secrets set KANE_USERNAME=... KANE_ACCESS_KEY=...), then start tzproof.
set -e
mkdir -p "$TZPROOF_DATA"
if [ -n "$KANE_USERNAME" ] && [ -n "$KANE_ACCESS_KEY" ]; then
  kane-cli login --username "$KANE_USERNAME" --access-key "$KANE_ACCESS_KEY" > /dev/null
else
  echo "KANE_USERNAME / KANE_ACCESS_KEY are not set: runs will fail until they are." >&2
fi
exec node bin/tzproof.js ui
