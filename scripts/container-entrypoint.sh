#!/usr/bin/env bash
set -euo pipefail

exec node packages/cli/dist/main.js "$@"

