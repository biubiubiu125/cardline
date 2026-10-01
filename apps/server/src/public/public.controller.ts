import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { clientAddress } from '../common/utils';
import { RedeemService, type PickupRecordInput } from './public.service';

@Controller('public')
export class PublicController {
  constructor(private readonly service: RedeemService) {}

  @Get('meta')
  meta() {
    return this.service.publicMeta();
  }

  @Post('redeem')
  redeem(@Body() body: Record<string, unknown>, @Req() request: Request) {
    return this.service.redeem({
      cards: body?.cards as string[],
      format: body?.format as string,
      limit: Number(body?.limit) || undefined,
      ip: clientIp(request),
      userAgent: request.headers['user-agent'],
    });
  }

  @Post('reclaim')
  async reclaim(
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    let aborted = false;
    const markAborted = () => {
      if (!response.writableFinished) aborted = true;
    };
    const socket = request.socket;
    response.on('close', markAborted);
    socket?.on('close', markAborted);
    const detachAbort = () => {
      response.off('close', markAborted);
      socket?.off('close', markAborted);
    };
    try {
      const result = await this.service.reclaim({
        cards: body?.cards,
        format: typeof body?.format === 'string' ? body.format : undefined,
        ip: clientIp(request),
        userAgent: request.headers['user-agent'],
        shouldStop: () => aborted,
      });
      if (!aborted) {
        const cards: string[] = [];
        if (Array.isArray(result?.results)) {
          for (const item of result.results) {
            if (item?.ok !== true || typeof item.card !== 'string') continue;
            const key = item.card.trim();
            if (key) cards.push(key);
          }
        }
        response.on('finish', () => {
          void this.service.releaseDeliveredHolds(cards);
        });
      }
      return result;
    } finally {
      // close 只用于找回进行中的中断判断。长连接会复用 socket，不摘掉就会把旧响应留住。
      detachAbort();
    }
  }

  @Post('pickup/resolve')
  resolve(@Body() body: Record<string, unknown>) {
    return this.service.resolvePickup({
      input: body?.input as string,
      files: body?.files as Array<{ name?: string; content?: string }>,
    });
  }

  @Post('pickup/fetch')
  fetch(@Body() body: Record<string, unknown>) {
    return this.service.fetchPickup({
      records: body?.records as Array<{
        key?: string;
        email?: string;
        line?: string;
        fromCard?: string | null;
      }>,
      maxMessages: Number(body?.maxMessages) || undefined,
      query: body?.query as string,
    });
  }

  @Post('pickup/export')
  @HttpCode(200)
  async exportPickup(@Body() body: Record<string, unknown>, @Res() response: Response) {
    const kind = body?.kind === 'email' ? 'email' : 'line';
    const result = await this.service.exportPickup({
      records: body?.records as PickupRecordInput[],
      kind,
      category: typeof body?.category === 'string' ? body.category : undefined,
    });
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename.replace(/[^\x20-\x7E]/g, '_')}"`,
    );
    response.send(result.content);
  }
}

function clientIp(request: Request): string {
  return clientAddress(request.headers, request.ip || request.socket?.remoteAddress || '');
}
