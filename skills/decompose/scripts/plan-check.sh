#!/usr/bin/env bash
# Usage: plan-check.sh <plan.json>
# Checks a decompose plan: template validity, estimates, unknown or cyclic blocks, file overlap without ordering.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$here/plan-check.ts" "$@"
