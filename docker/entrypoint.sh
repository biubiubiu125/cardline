#!/bin/sh
set -e

case "${DATABASE_URL:-}" in
  postgres://*|postgresql://*) ;;
  *)
    echo "[cardline] DATABASE_URL 必须是 PostgreSQL，已拒绝启动"
    exit 1
    ;;
esac

if [ "${SKIP_DB_INIT:-0}" != "1" ]; then
  echo "[cardline] 初始化数据库表结构…"
  node apps/server/scripts/bootstrap-db.js
fi

echo "[cardline] 启动服务：$*"
exec "$@"
