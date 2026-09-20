import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export interface AuthedRequest extends Request {
  user?: { id: number; username: string; role: string };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!token) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: '请先登录' });
    }

    try {
      const payload = await this.jwt.verifyAsync<{ sub: number; sessionVersion: number }>(token);
      if (!Number.isInteger(payload.sub) || !Number.isInteger(payload.sessionVersion)) {
        throw new Error('Invalid session');
      }
      const user = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
      if (!user || user.role !== 'admin' || user.sessionVersion !== payload.sessionVersion) {
        throw new Error('Revoked session');
      }
      request.user = { id: user.id, username: user.username, role: user.role };
      return true;
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录' });
    }
  }
}
