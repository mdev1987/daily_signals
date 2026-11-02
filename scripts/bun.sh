#!/bin/sh
# Resolve Bun consistently across local and VPS installations.
# Usage: ./scripts/bun.sh <bun args...>
set -eu

if command -v bun >/dev/null 2>&1; then
  exec bun "$@"
fi

for candidate in \
  "${HOME:-/home/mdev}/.bun/bin/bun" \
  "${HOME:-/home/mdev}/.local/bin/bun" \
  /usr/local/bin/bun \
  /usr/bin/bun
do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done

echo "bun executable not found. Install Bun or add it to PATH in oxfile.toml." >&2
exit 127
