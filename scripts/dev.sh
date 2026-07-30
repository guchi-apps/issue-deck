#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"

exec next dev -p "${PORT}"
