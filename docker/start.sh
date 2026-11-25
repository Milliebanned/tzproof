#!/bin/sh
# Sign Kane in from Fly secrets (KANE_USERNAME / KANE_ACCESS_KEY), then start tzproof.
# A failed sign-in must not take the site down: tzproof starts anyway and runs report the error.
mkdir -p "$TZPROOF_DATA"
if [ -n "$KANE_USERNAME" ] && [ -n "$KANE_ACCESS_KEY" ]; then
  if kane-cli login --username "$KANE_USERNAME" --access-key "$KANE_ACCESS_KEY" > /tmp/kane-login.log 2>&1; then
    echo "Kane CLI: signed in as $KANE_USERNAME"
  else
    echo "Kane CLI: sign-in FAILED for $KANE_USERNAME (check KANE_USERNAME / KANE_ACCESS_KEY):" >&2
    tail -2 /tmp/kane-login.log >&2
  fi
else
  echo "Kane CLI: KANE_USERNAME / KANE_ACCESS_KEY are not set, so runs will fail until they are." >&2
fi
exec node bin/tzproof.js ui
