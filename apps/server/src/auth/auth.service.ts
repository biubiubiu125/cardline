import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private get expiresInSeconds(): number {
    const raw = process.env.JWT_EXPIRES_IN || '7d';
    const match = /^(\d+)([smhd])?$/.exec(raw.trim());
    if (!match) return 7 * 24 * 3600;
    const value = Number(match[1]);
    const unit = match[2] || 's';
    const factor = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    return value * factor;
  }

  async login(username: string, password: string) {
    const user = await this.prisma.adminUser.findUnique({
      where: { username: String(username || '').trim() },
    });
    if (!user) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: '账号或密码错误' });

    const matched = await bcrypt.compare(String(password || ''), user.passwordHash);
    if (!matched) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: '账号或密码错误' });

    const token = await this.jwt.signAsync({
      sub: user.id,
      username: user.username,
      role: user.role,
      sessionVersion: user.sessionVersion,
    });

    return {
      token,
      expiresIn: this.expiresInSeconds,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    };
  }

  async profile(userId: number) {
    const user = await this.prisma.adminUser.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: '登录状态已失效' });
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    };
  }

  async changePassword(userId: number, oldPassword: string, newPassword: string) {
    const user = await this.prisma.adminUser.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: '登录状态已失效' });

    const matched = await bcrypt.compare(String(oldPassword || ''), user.passwordHash);
    if (!matched) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: '原密码不正确' });
    }
    if (!newPassword || String(newPassword).length < 6) {
      throw new UnauthorizedException({ code: 'BAD_INPUT', message: '新密码至少 6 位' });
    }

    const updated = await this.prisma.adminUser.updateMany({
      where: { id: user.id, passwordHash: user.passwordHash, sessionVersion: user.sessionVersion },
      data: {
        passwordHash: await bcrypt.hash(String(newPassword), 10),
        sessionVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: '密码已变更，请重新登录' });
    }
    return { ok: true };
  }
}
