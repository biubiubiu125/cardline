import type { PrismaClient } from '@prisma/client';
import { SCHEMA_STATEMENTS } from './schema-statements';

/** 新库建表与旧库迁移共用入口；失败时回滚并阻止服务启动。 */
export async function initializeSchema(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const statement of SCHEMA_STATEMENTS) {
      await tx.$executeRawUnsafe(statement);
    }

    const migrations = await tx.$queryRawUnsafe<Array<{ version: number }>>(
      'SELECT "version" FROM "SchemaMigration"',
    );
    if (!migrations.some((migration) => migration.version === 1)) {
      const adminColumns = await tx.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("AdminUser")');
      if (!adminColumns.some((column) => column.name === 'sessionVersion')) {
        await tx.$executeRawUnsafe('ALTER TABLE "AdminUser" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0');
      }
      const accountColumns = await tx.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("Account")');
      if (!accountColumns.some((column) => column.name === 'redeemedByCard')) {
        await tx.$executeRawUnsafe('ALTER TABLE "Account" ADD COLUMN "redeemedByCard" TEXT');
      }
      // 历史数据只能可靠恢复各卡的主账号，不能猜测过去未记录的附加交付。
      await tx.$executeRawUnsafe(
        `UPDATE "Account" SET "redeemedByCard" = "cardKey" WHERE "redeemStatus" = 'redeemed' AND "redeemedByCard" IS NULL`,
      );
      await tx.$executeRawUnsafe('INSERT INTO "SchemaMigration" ("version") VALUES (1)');
    }
    await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "Account_redeemedByCard_idx" ON "Account"("redeemedByCard")');
  }, { timeout: 30000 });
}
