#!/usr/bin/env bash
# 壳脚本：真正逻辑在 setup.mjs（安卓 / sdcard 上 chmod +x 不生效，请用 `bash uninstall.sh` 或 `node setup.mjs uninstall`）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/setup.mjs" uninstall "$@"
