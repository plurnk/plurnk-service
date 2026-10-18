#!/usr/bin/env bash

case "$1" in --help|-h)
    cat <<'USAGE'
usage: bash scripts/operator-environment.sh <command> [arguments...]
Re-executes the command under ~/.bashrc when one exists, so the provider credentials of the login shell reach live, demo, bench and candidate runs; runs it unchanged otherwise.
Reads: ~/.bashrc.
Writes: nothing.
USAGE
    exit 0 ;;
esac
set -euo pipefail

if [ -n "${HOME:-}" ] && [ -f "${HOME}/.bashrc" ]; then
    exec bash --noprofile --rcfile "${HOME}/.bashrc" -i -c 'exec "$@"' bash "$@"
fi

exec "$@"
