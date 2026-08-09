#!/usr/bin/env bash

set -euo pipefail

if [ -n "${HOME:-}" ] && [ -f "${HOME}/.bashrc" ]; then
    exec bash --noprofile --rcfile "${HOME}/.bashrc" -i -c 'exec "$@"' bash "$@"
fi

exec "$@"
