import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from './prisma/prisma.service';
import { DEFAULT_SETTINGS } from './settings/settings.service';
import { initializeSchema } from './prisma/initialize-schema';
import { initialAdminPassword } from './auth/security-config';

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger('Seed');

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
    await this.ensureAdmin();
    await this.ensureSettings();
  }

  /**
   * 幂等建表：保证「克隆仓库 → npm install → npm run dev」即可直接使用，
   * Docker 镜像里也不必携带 Prisma CLI。
   */
  private async ensureSchema(): Promise<void> {
    await initializeSchema(this.prisma);
  }

  private async ensureAdmin(): Promise<void> {
    const count = await this.prisma.adminUser.count();
    if (count > 0) return;

    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = initialAdminPassword();
    await this.prisma.adminUser.create({
      data: {
        username,
        passwordHash: await bcrypt.hash(password, 10),
        displayName: '管理员',
        role: 'admin',
      },
    });
    this.logger.log(`已创建后台账号：${username}`);
  }

  private async ensureSettings(): Promise<void> {
    const count = await this.prisma.setting.count();
    if (count > 0) return;
    await this.prisma.setting.createMany({
      data: Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({
        key,
        value: String(value),
      })),
    });
  }
}
