#!/usr/bin/env bash
set -euo pipefail

node packages/cli/dist/main.js migrate
node packages/cli/dist/main.js ingest osm --area les --from-file fixtures/osm/les-synthetic.json
node packages/cli/dist/main.js recommend --area les --at 2026-10-03T22:30:00Z --minutes 180 --all
node packages/cli/dist/main.js backtest --area les

