#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `dot sync` links bin/dot into ~/.local/bin itself, so there is nothing to set
# up here beyond running it once from the checkout.
exec "$REPO_ROOT/bin/dot" sync
