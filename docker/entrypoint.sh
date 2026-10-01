#!/bin/sh
set -e

# 密码单独传入，再转义后写入 DATABASE_URL。不要在 compose 里把密码直接拼进 URL。
if [ -n "${POSTGRES_USER:-}" ] && [ -n "${POSTGRES_DB:-}" ] && [ -n "${POSTGRES_PASSWORD+x}" ]; then
  DATABASE_URL="$(node -e 'const { postgresDatabaseUrl } = require("./apps/server/dist/common/database-url"); process.stdout.write(postgresDatabaseUrl({ user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD || "", host: process.env.POSTGRES_HOST || "postgres", port: process.env.POSTGRES_PORT || "5432", database: process.env.POSTGRES_DB, schema: process.env.POSTGRES_SCHEMA || "public" }));')"
  export DATABASE_URL
fi

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
