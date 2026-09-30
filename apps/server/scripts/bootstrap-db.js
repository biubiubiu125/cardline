#!/usr/bin/env node
/**
 * 数据库自举脚本：只依赖 Prisma Client，不需要 Prisma CLI。
 * 表结构定义与运行时共用 dist/prisma/schema-statements.js，避免两处漂移。
 *
 * 用法：DATABASE_URL=postgresql://... node scripts/bootstrap-db.js
 */
'use strict';

const path = require('node:path');

function databaseTarget(url) {
  try {
    const parsed = new URL(url);
    const schema = parsed.searchParams.get('schema');
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}${schema ? `?schema=${schema}` : ''}`;
  } catch {
    return '(无法解析的连接串)';
  }
}

async function main() {
  const url = process.env.DATABASE_URL || '';
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('DATABASE_URL 必须是 PostgreSQL 连接串，例如 postgresql://用户:密码@主机:5432/数据库');
  }

  const { initializeSchema } = require(path.resolve(__dirname, '..', 'dist', 'prisma', 'initialize-schema.js'));
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    console.log(`[bootstrap-db] 目标数据库：${databaseTarget(url)}`);
    await initializeSchema(prisma);
    console.log('[bootstrap-db] 表结构与版本迁移就绪');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[bootstrap-db] 初始化失败：', error);
  process.exit(1);
});
