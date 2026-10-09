#!/usr/bin/env bash
# Print selected claims of a JWT read from stdin. Never prints the token or signature.
set -euo pipefail
tok=$(cat)
payload=$(printf '%s' "$tok" | cut -d. -f2 | tr '_-' '/+')
# restore base64 padding
while [ $(( ${#payload} % 4 )) -ne 0 ]; do payload="${payload}="; done
printf '%s' "$payload" | base64 -d | jq '{iss, aud, sub, appid, azp, tid, iat, nbf, exp}'
