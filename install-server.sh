#!/usr/bin/env bash
# 壳脚本：真正逻辑在 setup.mjs（安卓 / sdcard 上 chmod +x 不生效，请用 `bash install-server.sh` 或 `node setup.mjs install-server`）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/setup.mjs" install-server "$@"
