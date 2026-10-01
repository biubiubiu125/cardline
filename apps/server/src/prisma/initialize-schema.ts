import type { Prisma, PrismaClient } from '@prisma/client';
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
      const adminColumns = await columnNames(tx, 'AdminUser');
      if (!adminColumns.has('sessionVersion')) {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "AdminUser" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0',
        );
      }
      const accountColumns = await columnNames(tx, 'Account');
      if (!accountColumns.has('redeemedByCard')) {
        await tx.$executeRawUnsafe('ALTER TABLE "Account" ADD COLUMN "redeemedByCard" TEXT');
      }
      // 历史数据只能可靠恢复各卡的主账号，不能猜测过去未记录的附加交付。
      await tx.$executeRawUnsafe(
        `UPDATE "Account" SET "redeemedByCard" = "cardKey" WHERE "redeemStatus" = 'redeemed' AND "redeemedByCard" IS NULL`,
      );
      await tx.$executeRawUnsafe('INSERT INTO "SchemaMigration" ("version") VALUES (1)');
    }
    await tx.$executeRawUnsafe('ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "stagedCredential" TEXT');
    await tx.$executeRawUnsafe(
      'ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "refreshHeld" BOOLEAN NOT NULL DEFAULT false',
    );
    await tx.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "Account_redeemedByCard_idx" ON "Account"("redeemedByCard")',
    );
  }, { timeout: 30000 });
}

async function columnNames(tx: Prisma.TransactionClient, table: string): Promise<Set<string>> {
  const rows = await tx.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}'`,
  );
  return new Set(rows.map((row) => row.column_name));
}
