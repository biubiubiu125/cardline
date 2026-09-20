#!/usr/bin/env node
/**
 * 数据库自举脚本：只依赖 Prisma Client，不需要 Prisma CLI。
 * 表结构定义与运行时共用 dist/prisma/schema-statements.js，避免两处漂移。
 *
 * 用法：node scripts/bootstrap-db.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 解析 SQLite 文件路径。
 * Prisma 的相对路径基准是 schema.prisma 所在目录（apps/server/prisma），
 * 而脚本的 cwd 可能是仓库根目录，因此这里显式对齐到 prisma 目录。
 */
function resolveDatabaseFile() {
  const url = process.env.DATABASE_URL || 'file:./cardline.db';
  const raw = url.replace(/^file:/, '');
  if (path.isAbsolute(raw)) return raw;

  const serverDir = path.resolve(__dirname, '..');
  const candidates = [
    path.resolve(serverDir, 'prisma', raw),
    path.resolve(process.cwd(), raw),
    path.resolve(process.cwd(), 'prisma', raw),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.dirname(candidate))) return candidate;
  }
  return candidates[0];
}

const absolute = resolveDatabaseFile();
fs.mkdirSync(path.dirname(absolute), { recursive: true });

const { initializeSchema } = require(path.resolve(__dirname, '..', 'dist', 'prisma', 'initialize-schema.js'));

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: `file:${absolute}` } },
});

async function main() {
  console.log(`[bootstrap-db] 目标数据库：${absolute}`);
  await initializeSchema(prisma);
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  } catch {
    /* 忽略 */
  }
  console.log('[bootstrap-db] 表结构与版本迁移就绪');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('[bootstrap-db] 初始化失败：', error);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
