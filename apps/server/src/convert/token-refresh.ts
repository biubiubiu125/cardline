import { Injectable } from '@nestjs/common';
import { MailboxService } from '../mailbox/mailbox.service';

export interface RefreshedCredentials {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt?: Date;
}

export interface TokenRefreshResult {
  ok: boolean;
  credentials?: RefreshedCredentials;
  error?: string;
}

/** 找回接口只依赖这个方法，测试可以换成不访问网络的假实现。 */
export interface TokenRefresher {
  refresh(refreshToken: string): Promise<TokenRefreshResult>;
}

/**
 * 生产刷新只把库里的 refreshToken 交给现有的 OpenAI 官方刷新。
 * 不读取邮箱密码，也不接收顾客上传的凭据。
 */
@Injectable()
export class TokenRefreshClient implements TokenRefresher {
  constructor(private readonly mailbox: MailboxService) {}

  async refresh(refreshToken: string): Promise<TokenRefreshResult> {
    const result = await this.mailbox.refreshOpenAiToken(refreshToken);
    if (!result.ok || !result.accessToken) {
      return { ok: false, error: result.error || '刷新失败' };
    }
    return {
      ok: true,
      credentials: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || refreshToken,
        idToken: result.idToken,
        expiresAt: result.expiresAt,
      },
    };
  }
}
