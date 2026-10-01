import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConvertService, readSub2ApiPassthrough } from '../convert/convert.service';
import { TokenRefreshClient, type TokenRefresher } from '../convert/token-refresh';
import { MailboxService } from '../mailbox/mailbox.service';
import { SettingsService } from '../settings/settings.service';
import { DELIVER_FORMATS, FORMAT_META, isDeliverFormat } from '../common/error-codes';
import { isPendingTier, tierFromMailCredits } from '../common/credits';
import {
  bizError,
  looksEmail,
  normalizeCardKey,
  safeFilename,
  splitTokens,
} from '../common/utils';
import type { NormalizedAccount } from '../convert/convert.types';
import type { MailboxCredential, PickupResult } from '../mailbox/mailbox.types';
import type { Account } from '@prisma/client';
import { withReclaimLock as lockReclaim } from './reclaim-lock';
import { serializeStagedCredential, stagedExpiresAt, stagedForAccount } from './staged-credential';
import { expiresAtFromJwt } from '../common/jwt-expiry';

const MAX_CARDS = 500;
const MAX_PICKUP_RECORDS = 20;
const SESSION_FILE_FORMATS = new Set(['cockpit', 'ninerouter', 'codex', 'axonhub', 'codex-manager']);

/**
 * 交付文件名：`<卡密>.sub2api.json` / `<卡密>.cpa.json` / `<卡密>.txt`。
 *
 * 名字里带格式，是因为 CPA 的批量下载会把这些文件打成一个 zip ——
 * 全都叫 `<卡密>.json` 的话，解压出来分不出是哪种格式。
 */
function deliverFilename(cardKey: string, format: string): string {
  const meta = FORMAT_META[format as keyof typeof FORMAT_META];
  const ext = meta?.ext || 'json';
  const stem = safeFilename(cardKey, 'card');
  return format === 'email' ? `${stem}.${ext}` : `${stem}.${format}.${ext}`;
}

function resolveDeliverFormat(requested: unknown, fallback: unknown): string {
  if (isDeliverFormat(requested)) return requested;
  if (isDeliverFormat(fallback)) return fallback;
  return 'sub2api';
}

function collectCardKeys(raw: unknown): string[] {
  const source = Array.isArray(raw) ? raw : [raw];
  const cards = [
    ...new Set(
      source
        .flatMap((item) => splitTokens(item))
        .map((item) => normalizeCardKey(item))
        .filter(Boolean),
    ),
  ];
  if (cards.length > MAX_CARDS) bizError('BAD_INPUT', `单次最多提交 ${MAX_CARDS} 张卡密`);
  return cards;
}

type RefreshedCredentialWrite = {
  id: number;
  accessToken: string;
  refreshToken: string;
  previousRefreshToken: string;
  idToken: string | null;
  expiresAt: Date | null;
};

function refreshedIdentity(
  credentials: { accessToken?: string; idToken?: string; expiresAt?: Date },
  previous: { idToken?: string | null },
): {
  idToken: string | null;
  expiresAt: Date | null;
} {
  const incomingId = typeof credentials.idToken === 'string' && credentials.idToken.trim() ? credentials.idToken.trim() : null;
  const incomingExpiry =
    credentials.expiresAt instanceof Date && !Number.isNaN(credentials.expiresAt.getTime()) ? credentials.expiresAt : null;
  return {
    idToken: incomingId || previous?.idToken || null,
    expiresAt: incomingExpiry || expiresAtFromJwt(credentials.accessToken),
  };
}

function mergedDeliverContent(
  convert: ConvertService,
  format: string,
  delivered: NormalizedAccount[],
): string | null {
  if (!delivered.length) return null;
  if (isDeliverFormat(format) && FORMAT_META[format].bundle === 'zip') return null;
  return convert.buildDeliverContent(format, delivered);
}

type DeliveryFile = { filename: string; content: string };

/** 写库失败时，邮箱文件后面另附凭据，避免新 token 只留在内存里。成功交付不走这里。 */
function emailWithTokens(convert: ConvertService, accounts: NormalizedAccount[]): string | null {
  if (!accounts.length) return null;
  const delivered = convert.buildDeliverContent('email', accounts);
  const tokens = convert.buildDeliverContent('sub2api', accounts);
  if (delivered && tokens) return `${delivered.trimEnd()}\n${tokens}`;
  return delivered || tokens;
}

/** 成功卡只留邮箱行；需要另附 JSON 的只有失败卡自己的账号。 */
function mergeEmailDownload(
  convert: ConvertService,
  saved: NormalizedAccount[],
  exposed: NormalizedAccount[],
): string | null {
  const parts: string[] = [];
  if (saved.length) {
    const text = convert.buildDeliverContent('email', saved);
    if (text) parts.push(text.trimEnd());
  }
  const hybrid = emailWithTokens(convert, exposed);
  if (hybrid) parts.push(hybrid.trimEnd());
  return parts.length ? parts.join('\n') : null;
}

/**
 * 会话格式一账号一文件。单账号仍用 content；多账号放 files，content 留空。
 * CPA 继续用原来的数组。邮箱成功时只保留四段或六段。
 */
function packDelivery(
  convert: ConvertService,
  format: string,
  cardKey: string,
  accounts: NormalizedAccount[],
  emailTokens: boolean,
): { filename: string | null; content: string | null; files?: DeliveryFile[] } {
  if (!accounts.length) return { filename: null, content: null };
  if (SESSION_FILE_FORMATS.has(format) && accounts.length > 1) {
    const stem = safeFilename(cardKey, 'card');
    const ext = FORMAT_META[format as keyof typeof FORMAT_META]?.ext || 'json';
    const used = new Set<string>();
    const files = accounts.map((account, index) => {
      const label = safeFilename(account.email || account.name || String(index + 1), String(index + 1));
      let filename = `${stem}-${index + 1}-${label}.${format}.${ext}`;
      while (used.has(filename)) filename = `${stem}-${index + 1}-${label}-${used.size}.${format}.${ext}`;
      used.add(filename);
      return { filename, content: convert.buildDeliverContent(format, [account]) };
    });
    return { filename: null, content: null, files };
  }
  const content =
    emailTokens && format === 'email'
      ? emailWithTokens(convert, accounts)
      : convert.buildDeliverContent(format, accounts);
  return { filename: deliverFilename(cardKey, format), content };
}

export interface ResolvedRecord {
  key: string;
  email: string;
  source: 'line' | 'json' | 'card' | 'email';
  complete: boolean;
  fromCard: string | null;
  credits: number | null;
  accountId: number | null;
  label: string;
  error: string | null;
  /** 仅回传用户自行提供的凭据，卡密对应的库内凭据不在解析阶段返回。 */
  line?: string;
}

export interface PickupRecordInput {
  key?: string;
  email?: string;
  line?: string;
  fromCard?: string | null;
}

interface PreparedPickupRecord {
  key: string;
  email: string;
  accountId: number | null;
  cardKey: string | null;
  credential: MailboxCredential | null;
}

type AccountWithMailbox = Account & { mailbox: any };

@Injectable()
export class RedeemService {
  private readonly logger = new Logger(RedeemService.name);

  private readonly refresher: TokenRefresher;

  constructor(
    private readonly prisma: PrismaService,
    private readonly convert: ConvertService,
    private readonly mailbox: MailboxService,
    private readonly settings: SettingsService,
    @Optional() @Inject(TokenRefreshClient) refresher?: TokenRefreshClient,
  ) {
    this.refresher = refresher ?? new TokenRefreshClient(mailbox);
  }

  // -------------------------------------------------------------------------
  // 前台元信息
  // -------------------------------------------------------------------------

  async publicMeta() {
    const settings = await this.settings.getAll();
    const grouped = await this.prisma.account.groupBy({
      by: ['credits', 'redeemStatus', 'banStatus', 'cardDisabled'],
      _count: { _all: true },
    });

    const byCreditsMap = new Map<
      number,
      { credits: number; total: number; available: number; redeemed: number }
    >();
    const ensure = (credits: number) => {
      if (!byCreditsMap.has(credits)) {
        byCreditsMap.set(credits, { credits, total: 0, available: 0, redeemed: 0 });
      }
      return byCreditsMap.get(credits)!;
    };

    let total = 0;
    let available = 0;
    let redeemed = 0;
    for (const group of grouped) {
      const count = group._count._all;
      total += count;
      // 待定档（额度 0）不对外展示，也不算可售
      if (isPendingTier(group.credits)) continue;

      const entry = ensure(group.credits);
      entry.total += count;
      const usable =
        group.redeemStatus === 'unredeemed' &&
        group.banStatus !== 'banned' &&
        group.banStatus !== 'invalid' &&
        !group.cardDisabled;
      if (usable) {
        entry.available += count;
        available += count;
      }
      if (group.redeemStatus === 'redeemed') {
        entry.redeemed += count;
        redeemed += count;
      }
    }

    const byCredits = [...byCreditsMap.values()].sort((a, b) => a.credits - b.credits);

    return {
      siteName: settings.siteName,
      siteSubtitle: settings.siteSubtitle,
      announcement: settings.announcement,
      formats: DELIVER_FORMATS.map((value) => ({
        value,
        label: FORMAT_META[value].label,
        ext: FORMAT_META[value].ext,
        hint: FORMAT_META[value].hint,
        bundle: FORMAT_META[value].bundle,
      })),
      /** 在售档位（= 账号实际额度，由邮箱取件命中关键字自动定档，非手工维护） */
      creditTiers: byCredits.filter((item) => item.available > 0).map((item) => item.credits),
      defaultFormat: settings.defaultFormat,
      redeemLimitPerCard: settings.redeemLimitPerCard,
      stats: {
        total,
        available,
        redeemed,
        byCredits,
      },
      pickup: {
        enabled: true,
        direct: true,
        maxRecords: MAX_PICKUP_RECORDS,
        maxMessages: settings.pickupMaxMessages,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 卡密兑换
  // -------------------------------------------------------------------------

  async redeem(payload: {
    cards?: unknown;
    format?: string;
    limit?: number;
    ip?: string;
    userAgent?: string;
  }) {
    const settings = await this.settings.getAll();
    const format = resolveDeliverFormat(payload?.format, settings.defaultFormat);

    const cards = collectCardKeys(payload?.cards);

    if (!cards.length) {
      return {
        format,
        results: [],
        summary: { total: 0, success: 0, failed: 0, credits: 0, accounts: 0 },
      };
    }

    const configuredLimit = Math.min(20, Math.max(1, Math.trunc(Number(settings.redeemLimitPerCard) || 1)));
    const limit = Math.min(configuredLimit, Math.max(1, Math.trunc(Number(payload?.limit) || configuredLimit)));

    const results: Array<Record<string, unknown>> = [];
    /** 各卡成功交付的账号，按提交顺序累积，用于生成「合并下载」的单份文档 */
    const delivered: NormalizedAccount[] = [];
    let successCount = 0;
    let failedCount = 0;
    let creditsSum = 0;
    let accountCount = 0;

    for (const cardKey of cards) {
      try {
        const { record, normalized } = await this.redeemOne(
          cardKey,
          format,
          limit,
          payload?.ip,
          payload?.userAgent,
        );
        results.push(record);
        if (record.ok) {
          successCount++;
          creditsSum += Number(record.credits) || 0;
          accountCount += Number(record.accountCount) || 0;
          delivered.push(...normalized);
        } else {
          failedCount++;
        }
      } catch {
        this.logger.warn('兑换失败，已跳过当前卡');
        failedCount++;
        results.push({
          card: cardKey,
          ok: false,
          code: 'INTERNAL',
          message: '兑换失败，请稍后重试',
          credits: null,
          accountCount: 0,
          redeemedAt: null,
          firstRedeem: false,
          filename: null,
          content: null,
          accounts: [],
        });
      }
    }

    return {
      format,
      results,
      // document 格式合并成一份；zip 格式由前台按卡打包，这里不并文件。
      mergedContent: mergedDeliverContent(this.convert, format, delivered),
      summary: {
        total: cards.length,
        success: successCount,
        failed: failedCount,
        credits: creditsSum,
        accounts: accountCount,
      },
    };
  }

  /**
   * 凭据找回：只接受已兑换卡密和交付格式。
   * 刷新在短事务外面进行，卡级咨询锁会盖住刷新和写库重试。
   * 写库失败只重试写库，不再拿旧 refresh token 请求第二次。
   */
  async reclaim(payload: {
    cards?: unknown;
    format?: string;
    ip?: string;
    userAgent?: string;
    shouldStop?: () => boolean;
  }) {
    const settings = await this.settings.getAll();
    const format = resolveDeliverFormat(payload?.format, settings.defaultFormat);
    const cards = collectCardKeys(payload?.cards);
    if (!cards.length) {
      return {
        format,
        results: [],
        mergedContent: null,
        summary: { total: 0, success: 0, failed: 0, credits: 0, accounts: 0 },
      };
    }

    const results: Array<Record<string, unknown>> = [];
    const saved: NormalizedAccount[] = [];
    const exposed: NormalizedAccount[] = [];
    let successCount = 0;
    let failedCount = 0;
    let creditsSum = 0;
    let accountCount = 0;
    for (const cardKey of cards) {
      if (payload.shouldStop?.()) break;
      let record: Record<string, unknown>;
      let normalized: NormalizedAccount[] = [];
      try {
        ({ record, normalized } = await this.reclaimOne(cardKey, format, payload?.ip, payload?.userAgent));
      } catch {
        this.logger.warn('找回失败，已跳过当前卡，不再请求刷新');
        failedCount += 1;
        results.push({
          card: cardKey,
          ok: false,
          code: 'INTERNAL',
          message: '找回失败，请稍后重试',
          credits: null,
          accountCount: 0,
          firstRedeem: false,
          filename: null,
          content: null,
          accounts: [],
        });
        continue;
      }
      results.push(record);
      if (record.ok) {
        successCount += 1;
        creditsSum += Number(record.credits) || 0;
        accountCount += Number(record.accountCount) || 0;
        saved.push(...normalized);
      } else {
        failedCount += 1;
        if ((record.code === 'PERSIST_FAILED' || record.code === 'REFRESH_FAILED') && normalized.length) {
          exposed.push(...normalized);
        }
      }
    }
    const delivered = [...saved, ...exposed];
    return {
      format,
      results,
      mergedContent:
        format === 'email' && exposed.length
          ? mergeEmailDownload(this.convert, saved, exposed)
          : mergedDeliverContent(this.convert, format, delivered),
      summary: {
        total: cards.length,
        success: successCount,
        failed: failedCount,
        credits: creditsSum,
        accounts: accountCount,
      },
    };
  }

  private async reclaimOne(
    cardKey: string,
    format: string,
    ip?: string,
    userAgent?: string,
  ): Promise<{ record: Record<string, unknown>; normalized: NormalizedAccount[] }> {
    const rotated: RefreshedCredentialWrite[] = [];
    const source: AccountWithMailbox[] = [];
    const preserved: AccountWithMailbox[] = [];
    try {
      const outcome = await this.withReclaimLock(cardKey, () => this.refreshAndStore(cardKey, format, source, rotated, preserved));
      return this.finishReclaim(cardKey, outcome.accountId, outcome.credits, format, outcome, ip, userAgent);
    } catch {
      this.logger.warn('找回凭据写库失败，不再请求刷新');
      const primary = source.find((item) => item.cardKey === cardKey) || source[0];
      if (!rotated.length || !primary) {
        return this.finishReclaim(
          cardKey,
          primary?.id ?? null,
          primary?.credits ?? 0,
          format,
          this.reclaimFailure(cardKey, 'INTERNAL', '找回失败，请稍后重试'),
          ip,
          userAgent,
        );
      }
      try {
        for (const write of rotated) await this.stageRefreshedCredential(write);
        await this.writeRefreshedCredentials(rotated, cardKey, true);
      } catch {
        return this.finishReclaim(
          cardKey,
          primary.id,
          primary.credits,
          format,
          this.rotatedFailure(cardKey, format, 'PERSIST_FAILED', '凭据已刷新，但没有写入数据库。请立即保存本次结果，旧刷新凭据可能已经失效', source, rotated, preserved),
          ip,
          userAgent,
        );
      }
      if (rotated.length === source.length) {
        const delivered = await this.deliverSaved(cardKey, format, source, rotated, []);
        return this.finishReclaim(
          cardKey,
          primary.id,
          primary.credits,
          format,
          delivered || this.reclaimFailure(cardKey, 'INTERNAL', '找回失败，请稍后重试', primary.id, primary.credits),
          ip,
          userAgent,
        );
      }
      return this.finishReclaim(
        cardKey,
        primary.id,
        primary.credits,
        format,
        this.rotatedFailure(cardKey, format, 'REFRESH_FAILED', '部分凭据已刷新并写入。请立即保存本次结果，未成功的账号没有换新凭据', source, rotated, preserved),
        ip,
        userAgent,
      );
    }
  }

  /** 咨询锁盖住读、刷新和写库重试，但 HTTP 刷新不放进 Prisma 事务。 */
  private async withReclaimLock<T>(cardKey: string, fn: () => Promise<T>): Promise<T> {
    return lockReclaim(this.prisma, cardKey, fn);
  }

  private async refreshAndStore(
    cardKey: string,
    format: string,
    source: AccountWithMailbox[],
    rotated: RefreshedCredentialWrite[],
    preserved: AccountWithMailbox[],
  ) {
    const account = await this.prisma.account.findUnique({ where: { cardKey }, include: { mailbox: true } });
    if (!account) return this.reclaimFailure(cardKey, 'CARD_INVALID', '卡密不存在');
    if (account.cardDisabled) return this.reclaimFailure(cardKey, 'CARD_DISABLED', '卡密已停用', account.id, account.credits);
    if (account.redeemStatus !== 'redeemed') {
      return this.reclaimFailure(cardKey, 'CARD_NOT_REDEEMED', '该卡密尚未兑换，不能找回', account.id, account.credits);
    }
    if (account.redeemedByCard && account.redeemedByCard !== cardKey) {
      return this.reclaimFailure(cardKey, 'CARD_ALLOCATED', '卡密归属不一致', account.id, account.credits);
    }
    if (account.banStatus === 'banned' || account.banStatus === 'invalid') {
      return this.reclaimFailure(cardKey, 'NO_STOCK', '交付账号已封禁或凭据失效，请联系管理员', account.id, account.credits);
    }
    if (!account.redeemedByCard) {
      await this.prisma.account.update({ where: { id: account.id }, data: { redeemedByCard: cardKey } });
    }

    const accounts = await this.prisma.account.findMany({
      where: { redeemedByCard: cardKey },
      include: { mailbox: true },
      orderBy: { id: 'asc' },
    });
    source.splice(0, source.length, ...accounts);
    if (!accounts.length || accounts.some((item) => item.cardDisabled || ['banned', 'invalid'].includes(item.banStatus))) {
      return this.reclaimFailure(cardKey, 'NO_STOCK', '交付账号已停用、封禁或凭据失效，请联系管理员', account.id, account.credits);
    }
    if (accounts.some((item) => !item.refreshToken)) {
      return this.reclaimFailure(cardKey, 'REFRESH_MISSING', '该卡缺少可刷新凭据', account.id, account.credits);
    }

    for (const item of accounts) {
      const staged = stagedForAccount(item);
      // 已经落库且没有新的暂存时，无论同卡是否还有未完成账号，都不再轮换这份凭据。
      if (item.refreshHeld && !staged) {
        preserved.push(item);
        continue;
      }
      let write: RefreshedCredentialWrite;
      if (staged) {
        write = {
          id: item.id,
          accessToken: staged.accessToken,
          refreshToken: staged.refreshToken,
          previousRefreshToken: String(item.refreshToken),
          idToken: staged.idToken,
          expiresAt: stagedExpiresAt(staged.expiresAt),
        };
      } else {
        const refreshed = await this.refresher.refresh(String(item.refreshToken));
        if (!refreshed.ok || !refreshed.credentials?.accessToken || !refreshed.credentials.refreshToken) {
          if (rotated.length || preserved.length) {
            return this.rotatedFailure(
              cardKey,
              format,
              'REFRESH_FAILED',
              '部分凭据已刷新并写入。请立即保存本次结果，未成功的账号没有换新凭据',
              source,
              rotated,
              preserved,
            );
          }
          return this.reclaimFailure(cardKey, 'REFRESH_FAILED', '凭据刷新失败，请稍后重试或联系管理员', account.id, account.credits);
        }
        const identity = refreshedIdentity(refreshed.credentials, item);
        write = {
          id: item.id,
          accessToken: refreshed.credentials.accessToken,
          refreshToken: refreshed.credentials.refreshToken,
          previousRefreshToken: String(item.refreshToken),
          idToken: identity.idToken,
          expiresAt: identity.expiresAt,
        };
      }
      rotated.push(write);
      let stagedOk = false;
      try {
        await this.commitRotatedCredential(write, cardKey, true);
        stagedOk = true;
      } catch {
        if (!stagedOk) {
          const current = await this.prisma.account.findUnique({ where: { id: write.id } }).catch(() => null);
          stagedOk = Boolean(
            current && (current.refreshToken === write.refreshToken || stagedForAccount(current)),
          );
        }
        return this.rotatedFailure(
          cardKey,
          format,
          'PERSIST_FAILED',
          stagedOk
            ? '凭据已刷新并已暂存。请保存本次结果；再次找回不会重新刷新'
            : '凭据已刷新，但没有写入数据库。请立即保存本次结果，旧刷新凭据可能已经失效',
          source,
          rotated,
          preserved,
        );
      }
    }
    const delivered = await this.deliverSaved(cardKey, format, source, rotated, preserved);
    if (!delivered) throw new Error('找回文件生成失败');
    if (!rotated.length && preserved.length) {
      delivered.record.message = '凭据已经刷新过，本次没有重新轮换';
    }
    return delivered;
  }

  /**
   * 凭据已经落库后才生成文件。这里不清除 refreshHeld，要等响应完整写出后再解除。
   * 回读失败时用内存里的新凭据组文件；组包也失败则交给外层保持持有标记。
   */
  private async deliverSaved(
    cardKey: string,
    format: string,
    source: AccountWithMailbox[],
    rotated: RefreshedCredentialWrite[],
    preserved: AccountWithMailbox[],
  ) {
    try {
      const success = await this.reclaimSuccess(cardKey, format);
      return success;
    } catch {
      this.logger.warn('找回文件生成失败，凭据已落库，不再请求刷新');
      try {
        return this.rotatedFailure(
          cardKey,
          format,
          'REFRESH_FAILED',
          '凭据已写入，但本次读取交付文件失败。请保存本次结果；再次找回不会重新刷新',
          source,
          rotated,
          preserved,
        );
      } catch {
        return null;
      }
    }
  }

  private reclaimFailure(cardKey: string, code: string, message: string, accountId: number | null = null, credits = 0) {
    return {
      accountId,
      credits,
      normalized: [] as NormalizedAccount[],
      record: {
        card: cardKey,
        ok: false,
        code,
        message,
        credits: null,
        accountCount: 0,
        firstRedeem: false,
        filename: null,
        content: null,
        accounts: [],
      },
    };
  }

  private rotatedFailure(
    cardKey: string,
    format: string,
    code: string,
    message: string,
    source: AccountWithMailbox[],
    rotated: RefreshedCredentialWrite[],
    preserved: AccountWithMailbox[] = [],
  ) {
    const normalized = this.withRefreshedTokens(source, rotated, preserved);
    const primary = source.find((item) => item.cardKey === cardKey) || source[0];
    const included = new Set<number>([...rotated.map((item) => item.id), ...preserved.map((item) => item.id)]);
    const packed = packDelivery(this.convert, format, cardKey, normalized, true);
    return {
      accountId: primary?.id ?? null,
      credits: primary?.credits ?? 0,
      normalized,
      record: {
        card: cardKey,
        ok: false,
        code,
        message,
        credits: primary?.credits ?? null,
        accountCount: normalized.length,
        firstRedeem: false,
        filename: packed.filename,
        content: packed.content,
        ...(packed.files ? { files: packed.files } : {}),
        accounts: source
          .filter((item) => included.has(item.id))
          .map((item) => ({
            id: item.id,
            name: item.name,
            credits: item.credits,
            planType: item.planType,
            email: item.email,
          })),
      },
    };
  }

  private async reclaimSuccess(cardKey: string, format: string) {
    const fresh = await this.prisma.account.findMany({
      where: { redeemedByCard: cardKey },
      include: { mailbox: true },
      orderBy: { id: 'asc' },
    });
    const normalized = fresh.map((item) => this.toNormalized(item));
    const primary = fresh.find((item) => item.cardKey === cardKey) || fresh[0];
    const packed = packDelivery(this.convert, format, cardKey, normalized, false);
    return {
      accountId: primary?.id ?? null,
      credits: primary?.credits ?? 0,
      normalized,
      record: {
        card: cardKey,
        ok: true,
        code: 'OK',
        message: '凭据已刷新',
        credits: primary?.credits ?? null,
        accountCount: fresh.length,
        redeemedAt: primary?.redeemedAt ? primary.redeemedAt.toISOString() : null,
        firstRedeem: false,
        filename: packed.filename,
        content: packed.content,
        ...(packed.files ? { files: packed.files } : {}),
        accounts: fresh.map((item) => ({
          id: item.id,
          name: item.name,
          credits: item.credits,
          planType: item.planType,
          email: item.email,
        })),
      },
    };
  }

  private async finishReclaim(
    cardKey: string,
    accountId: number | null,
    credits: number,
    format: string,
    result: {
      record: Record<string, unknown>;
      normalized: NormalizedAccount[];
      accountId?: number | null;
      credits?: number;
    },
    ip?: string,
    userAgent?: string,
  ) {
    await this.log(
      cardKey,
      accountId,
      credits,
      `reclaim:${format}`,
      Boolean(result.record.ok),
      String(result.record.code),
      ip,
      userAgent,
    );
    return result;
  }

  /**
   * 锁内提交一份新凭据。暂存失败会再走一轮，避免第一次写失败就直接返回、下次又拿旧 token 去刷新。
   * 仍然不调用 OpenAI。
   */
  private async commitRotatedCredential(
    write: RefreshedCredentialWrite,
    cardKey: string,
    refreshHeld: boolean,
  ): Promise<void> {
    let staged = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!staged) {
          await this.stageRefreshedCredential(write);
          staged = true;
        }
        await this.writeRefreshedCredentials([write], cardKey, refreshHeld);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('找回凭据写库失败');
  }

  /** 刷新请求已经完成。这里只重试数据库写入，不能再次调用刷新。 */
  private async writeRefreshedCredentials(
    updates: RefreshedCredentialWrite[],
    cardKey: string,
    refreshHeld?: boolean,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.applyRefreshedTokens(tx, updates, cardKey, refreshHeld);
        });
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(`找回凭据写库失败，第 ${attempt} 次，不再请求刷新`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('找回凭据写库失败');
  }

  /** 先把新凭据落到暂存列。这一步失败时，下一次找回只能再看到旧凭据。 */
  private async stageRefreshedCredential(write: RefreshedCredentialWrite): Promise<void> {
    const payload = serializeStagedCredential(write);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const current = await this.prisma.account.findUnique({ where: { id: write.id } });
        if (!current) throw new Error('找回凭据写库失败');
        if (current.refreshToken === write.refreshToken && current.accessToken === write.accessToken) return;
        if (current.stagedCredential === payload && current.refreshToken === write.previousRefreshToken) return;
        const changed = await this.prisma.account.updateMany({
          where: { id: write.id, refreshToken: write.previousRefreshToken },
          data: { stagedCredential: payload },
        });
        if (!changed.count) throw new Error('找回凭据写库失败');
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(`找回凭据暂存失败，第 ${attempt} 次，不再请求刷新`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('找回凭据写库失败');
  }

  /** 响应已经完整写出后才解除持有。连接中断时不要调用，避免下一轮找回把没送到的凭据再轮换掉。 */
  async releaseDeliveredHolds(cards: string[]): Promise<void> {
    const seen = new Set<string>();
    for (const cardKey of cards) {
      const key = typeof cardKey === 'string' ? cardKey.trim() : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      await this.clearRefreshHold(key);
    }
  }

  private async clearRefreshHold(cardKey: string): Promise<void> {
    try {
      await this.prisma.account.updateMany({
        where: { redeemedByCard: cardKey, refreshHeld: true },
        data: { refreshHeld: false },
      });
    } catch {
      this.logger.warn('清除未完成找回标记失败，不再请求刷新');
    }
  }

  private async applyRefreshedTokens(
    tx: {
      account: {
        updateMany(args: {
          where: { id: number; refreshToken: string };
          data: Record<string, unknown>;
        }): Promise<{ count: number }>;
        findUnique(args: { where: { id: number } }): Promise<{ accessToken?: string; refreshToken?: string | null } | null>;
      };
    },
    updates: RefreshedCredentialWrite[],
    cardKey: string,
    refreshHeld?: boolean,
  ): Promise<void> {
    for (const item of updates) {
      const data: Record<string, unknown> = {
        accessToken: item.accessToken,
        refreshToken: item.refreshToken,
        idToken: item.idToken,
        expiresAt: item.expiresAt,
        redeemedByCard: cardKey,
        stagedCredential: null,
      };
      if (typeof refreshHeld === 'boolean') data.refreshHeld = refreshHeld;
      const changed = await tx.account.updateMany({
        where: { id: item.id, refreshToken: item.previousRefreshToken },
        data,
      });
      if (changed.count) continue;
      const current = await tx.account.findUnique({ where: { id: item.id } });
      if (current?.refreshToken === item.refreshToken && current.accessToken === item.accessToken) continue;
      throw new Error('找回凭据写库失败');
    }
  }

  private withRefreshedTokens(
    accounts: AccountWithMailbox[],
    updates: RefreshedCredentialWrite[],
    preserved: AccountWithMailbox[] = [],
  ): NormalizedAccount[] {
    const byId = new Map(updates.map((item) => [item.id, item]));
    const preservedIds = new Set(preserved.map((item) => item.id));
    return accounts
      .filter((account) => byId.has(account.id) || preservedIds.has(account.id))
      .map((account) => {
        const next = byId.get(account.id);
        if (!next) return this.toNormalized(account);
        return this.toNormalized({
          ...account,
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          idToken: next.idToken,
          expiresAt: next.expiresAt,
        });
      });
  }

  private async redeemOne(
    cardKey: string,
    format: string,
    limit: number,
    ip?: string,
    userAgent?: string,
  ): Promise<{ record: Record<string, unknown>; normalized: NormalizedAccount[]; stagedDelivery: boolean }> {
    return this.withReclaimLock(cardKey, () => this.redeemOneLocked(cardKey, format, limit, ip, userAgent));
  }

  private async redeemOneLocked(
    cardKey: string,
    format: string,
    limit: number,
    ip?: string,
    userAgent?: string,
  ): Promise<{ record: Record<string, unknown>; normalized: NormalizedAccount[]; stagedDelivery: boolean }> {
    const fail = (
      code: string,
      message: string,
    ): { record: Record<string, unknown>; normalized: NormalizedAccount[] } => ({
      normalized: [],
      record: {
        card: cardKey,
        ok: false,
        code,
        message,
        credits: null,
        accountCount: 0,
        redeemedAt: null,
        firstRedeem: false,
        filename: null,
        content: null,
        accounts: [],
      },
    });

    let accountId: number | null = null;
    const stagedWrites: RefreshedCredentialWrite[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      const redeemedAt = new Date();
      // 第一个语句先竞争写锁，后续查库存与占用附加账号始终处于同一事务。
      const claimed = await tx.account.updateMany({
        where: {
          cardKey,
          redeemStatus: 'unredeemed',
          redeemedByCard: null,
          cardDisabled: false,
          credits: { gt: 0 },
          banStatus: { notIn: ['banned', 'invalid'] },
        },
        data: { redeemStatus: 'redeemed', redeemedByCard: cardKey, redeemedAt },
      });
      const account = await tx.account.findUnique({ where: { cardKey }, include: { mailbox: true } });
      if (!account) return fail('CARD_INVALID', '卡密不存在');
      accountId = account.id;
      if (account.cardDisabled) return fail('CARD_DISABLED', '该卡密已被停用');
      if (account.redeemedByCard && account.redeemedByCard !== cardKey) {
        return fail('CARD_ALLOCATED', '该账号已归属其他卡密的交付，请联系管理员');
      }
      if (isPendingTier(account.credits)) {
        return fail('CREDITS_PENDING', '该卡密账号额度待定，请稍后重试');
      }
      if (['banned', 'invalid'].includes(account.banStatus)) {
        return fail('NO_STOCK', '该卡密对应账号已封禁或凭据失效，请联系管理员');
      }

      const isFirstRedeem = claimed.count === 1;
      if (!account.redeemedByCard) {
        // 兼容管理员标记为已兑换、但尚未建立交付归属的单账号。
        await tx.account.update({ where: { id: account.id }, data: { redeemedByCard: cardKey } });
      }
      if (isFirstRedeem && limit > 1) {
        // PostgreSQL 读已提交下，普通查询会让两张卡同时看中同一批库存。
        // SKIP LOCKED 让并发兑换各自锁住不同的行，避免重复交付。
        const extra = await tx.$queryRaw<Array<{ id: number }>>`
          SELECT id FROM "Account"
          WHERE credits = ${account.credits}
            AND "redeemStatus" = 'unredeemed'
            AND "redeemedByCard" IS NULL
            AND "banStatus" NOT IN ('banned', 'invalid')
            AND "cardDisabled" = false
          ORDER BY id ASC
          LIMIT ${limit - 1}
          FOR UPDATE SKIP LOCKED
        `;
        const extraIds = extra.map((item) => Number(item.id));
        if (extraIds.length) {
          await tx.account.updateMany({
            where: { id: { in: extraIds } },
            data: { redeemStatus: 'redeemed', redeemedByCard: cardKey, redeemedAt, redeemCount: { increment: 1 } },
          });
        }
      }

      const accounts = await tx.account.findMany({
        where: { redeemedByCard: cardKey },
        include: { mailbox: true },
        orderBy: { id: 'asc' },
      });
      if (accounts.some((item) => item.cardDisabled || ['banned', 'invalid'].includes(item.banStatus))) {
        return fail('NO_STOCK', '交付账号已停用、封禁或凭据失效，请联系管理员');
      }
      const normalized = accounts.map((item) => {
        const staged = stagedForAccount(item);
        if (!staged || !item.refreshToken) return this.toNormalized(item);
        const write: RefreshedCredentialWrite = {
          id: item.id,
          accessToken: staged.accessToken,
          refreshToken: staged.refreshToken,
          previousRefreshToken: item.refreshToken,
          idToken: staged.idToken,
          expiresAt: stagedExpiresAt(staged.expiresAt),
        };
        stagedWrites.push(write);
        return this.toNormalized({
          ...item,
          accessToken: write.accessToken,
          refreshToken: write.refreshToken,
          idToken: write.idToken,
          expiresAt: write.expiresAt,
        });
      });
      // 在事务内生成交付文件，转换异常会回滚本次库存占用。
      const packed = packDelivery(this.convert, format, cardKey, normalized, false);
      await tx.account.update({ where: { id: account.id }, data: { redeemCount: { increment: 1 } } });
      return {
        normalized,
        record: {
          card: cardKey,
          ok: true,
          code: 'OK',
          message: isFirstRedeem ? '兑换成功' : '已兑换过，本次为同批账号重新导出',
          credits: account.credits,
          accountCount: accounts.length,
          redeemedAt: (account.redeemedAt || redeemedAt).toISOString(),
          firstRedeem: isFirstRedeem,
          filename: packed.filename,
          content: packed.content,
          ...(packed.files ? { files: packed.files } : {}),
          accounts: accounts.map((item) => ({
            id: item.id, name: item.name, credits: item.credits, planType: item.planType, email: item.email,
          })),
        },
      };
    }, { maxWait: 10000, timeout: 15000 });
    if (result.record.ok && stagedWrites.length) {
      try {
        const held = await this.prisma.account.count({
          where: { redeemedByCard: cardKey, refreshHeld: true },
        });
        await this.writeRefreshedCredentials(stagedWrites, cardKey, held > 0 ? true : undefined);
      } catch {
        this.logger.warn('兑换导出时提交暂存凭据失败，文件已按暂存凭据生成');
      }
    }
    await this.log(cardKey, accountId, Number(result.record.credits) || 0, format, Boolean(result.record.ok), String(result.record.code), ip, userAgent);
    return { ...result, stagedDelivery: stagedWrites.length > 0 };
  }

  private toNormalized(account: AccountWithMailbox): NormalizedAccount {
    let raw: Record<string, unknown> | undefined;
    if (account.rawJson) {
      try {
        const parsed = JSON.parse(account.rawJson);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
      } catch {
        raw = undefined;
      }
    }
    const mailbox: MailboxCredential | undefined = account.mailbox?.email
      ? {
          email: account.mailbox.email,
          provider: account.mailbox.provider || 'outlook',
          authType: account.mailbox.authType || 'oauth2',
          password: account.mailbox.password || undefined,
          clientId: account.mailbox.clientId || undefined,
          refreshToken: account.mailbox.refreshToken || undefined,
          imapHost: account.mailbox.imapHost || 'outlook.office365.com',
          imapPort: account.mailbox.imapPort || 993,
          line:
            account.mailbox.line ||
            [
              account.mailbox.email,
              account.mailbox.password || '',
              account.mailbox.clientId || '',
              account.mailbox.refreshToken || '',
            ].join('----'),
        }
      : account.email && looksEmail(account.email)
        ? { email: account.email, provider: 'outlook', authType: 'oauth2' }
        : undefined;

    return {
      name: account.name,
      email: account.email || undefined,
      planType: account.planType || undefined,
      accountId: account.accountId || undefined,
      userId: account.userId || undefined,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken || undefined,
      idToken: account.idToken || undefined,
      sessionToken: account.sessionToken || undefined,
      expiresAt: account.expiresAt ? account.expiresAt.toISOString() : undefined,
      accessTokenExpiresAt: account.expiresAt ? Math.trunc(account.expiresAt.getTime() / 1000) : undefined,
      rawSource: (account.rawSource as 'sub2api' | 'cpa') || 'sub2api',
      raw,
      mailbox,
      // extra（含 two_factor_*）/ concurrency / rate_multiplier 等只存在 rawJson 里，
      // 不回填的话交付文件会丢掉这些字段
      ...readSub2ApiPassthrough(raw),
    };
  }

  private async log(
    cardKey: string,
    accountId: number | null,
    credits: number,
    format: string,
    success: boolean,
    message: string,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    try {
      await this.prisma.redeemLog.create({
        data: {
          cardKey,
          accountId: accountId ?? undefined,
          credits: Number(credits) || 0,
          format,
          success,
          message,
          ip: ip || null,
          userAgent: userAgent ? String(userAgent).slice(0, 250) : null,
        },
      });
    } catch (error) {
      this.logger.warn(`写入兑换日志失败：${error instanceof Error ? error.message : error}`);
    }
  }

  // -------------------------------------------------------------------------
  // 取件：解析
  // -------------------------------------------------------------------------

  async resolvePickup(payload: { input?: string; files?: Array<{ name?: string; content?: string }> }) {
    const textBlocks: string[] = [];
    if (payload?.input && String(payload.input).trim()) textBlocks.push(String(payload.input));
    for (const file of payload?.files || []) {
      if (file?.content && String(file.content).trim()) textBlocks.push(String(file.content));
    }

    const records = new Map<string, ResolvedRecord>();
    const unknown: string[] = [];

    const addRecord = (record: ResolvedRecord): void => {
      const existing = records.get(record.key);
      if (!existing || (!existing.complete && record.complete)) records.set(record.key, record);
    };

    for (const block of textBlocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      // 整体 JSON（sub2api / CPA / 数组）
      const parsedWhole = tryJson(trimmed);
      if (parsedWhole !== undefined) {
        this.collectFromJson(parsedWhole, addRecord);
        continue;
      }

      for (const rawLine of trimmed.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        const parsedLine = tryJson(line);
        if (parsedLine !== undefined) {
          this.collectFromJson(parsedLine, addRecord);
          continue;
        }

        if (line.includes('----')) {
          const credential = this.mailbox.parseCredential(line);
          if (credential?.email) {
            addRecord(this.recordFromCredential(credential, 'line'));
          } else {
            unknown.push(line);
          }
          continue;
        }

        // 卡密（形如 CARD-XXXXX-XXXXX-XXXXX）
        if (/^[A-Z0-9]{3,12}(-[A-Z0-9]{3,12}){2,4}$/.test(line)) {
          const cardKey = normalizeCardKey(line);
          const accounts = await this.pickupAccountsForCard(cardKey);
          if (accounts.length) {
            for (const account of accounts) {
              const credential = this.credentialOf(account);
              addRecord({
                key: (credential?.email || account.email || account.name).toLowerCase(),
                email: credential?.email || account.email || account.name,
                source: 'card',
                complete: this.mailbox.isComplete(credential),
                fromCard: cardKey,
                credits: isPendingTier(account.credits) ? null : account.credits,
                accountId: account.id,
                label: '卡密',
                error: this.mailbox.isComplete(credential)
                  ? null
                  : '卡密对应的账号缺少完整取件凭据（client_id / refresh_token）',
              });
            }
            continue;
          }
          unknown.push(line);
          continue;
        }

        if (looksEmail(line)) {
          const email = line.toLowerCase();
          addRecord({
            key: email,
            email,
            source: 'email',
            complete: false,
            fromCard: null,
            credits: null,
            accountId: null,
            label: '仅邮箱',
            error: '请提供卡密或完整邮箱凭据，仅邮箱地址不能取件',
          });
          continue;
        }

        unknown.push(line);
      }
    }

    const list = [...records.values()];
    return {
      records: list,
      summary: {
        total: list.length,
        complete: list.filter((item) => item.complete).length,
        incomplete: list.filter((item) => !item.complete).length,
        unknown: unknown.length,
      },
      unknown: unknown.slice(0, 50),
    };
  }

  private recordFromCredential(
    credential: MailboxCredential,
    source: ResolvedRecord['source'],
  ): ResolvedRecord {
    return {
      key: credential.email.toLowerCase(),
      email: credential.email,
      source,
      complete: this.mailbox.isComplete(credential),
      fromCard: null,
      credits: null,
      accountId: null,
      label: source === 'json' ? 'JSON' : '凭据行',
      error: this.mailbox.isComplete(credential)
        ? null
        : '凭据不完整，需要 邮箱----密码----clientid----refresh_token',
      line: this.mailbox.parseCredential(credential)?.line,
    };
  }

  private collectFromJson(parsed: unknown, addRecord: (record: ResolvedRecord) => void): void {
    const result = this.convert.parseAccounts(JSON.stringify(parsed), 'pickup-input');
    for (const item of result.items) {
      const credential = item.account.mailbox;
      if (credential?.email) {
        addRecord(
          this.recordFromCredential(
            {
              provider: 'outlook',
              authType: 'oauth2',
              ...credential,
              email: credential.email,
            },
            'json',
          ),
        );
      } else if (item.account.email && looksEmail(item.account.email)) {
        const email = item.account.email.toLowerCase();
        addRecord({
          key: email,
          email,
          source: 'json',
          complete: false,
          fromCard: null,
          credits: null,
          accountId: null,
          label: 'JSON',
          error: 'JSON 中缺少邮箱取件凭据（client_id / refresh_token）',
        });
      }
    }
  }

  private credentialOf(account: AccountWithMailbox): MailboxCredential | null {
    if (account.mailbox?.email) {
      return this.mailbox.parseCredential({
        email: account.mailbox.email,
        provider: account.mailbox.provider,
        authType: account.mailbox.authType,
        password: account.mailbox.password,
        clientId: account.mailbox.clientId,
        refreshToken: account.mailbox.refreshToken,
        imapHost: account.mailbox.imapHost,
        imapPort: account.mailbox.imapPort,
        line: account.mailbox.line,
      });
    }
    if (account.email && looksEmail(account.email)) {
      return this.mailbox.parseCredential(account.email);
    }
    return null;
  }

  private async pickupAccountsForCard(cardKey: string): Promise<AccountWithMailbox[]> {
    const owner = await this.prisma.account.findUnique({ where: { cardKey }, include: { mailbox: true } });
    if (!owner || owner.cardDisabled || (owner.redeemedByCard && owner.redeemedByCard !== cardKey)) return [];
    if (!owner.redeemedByCard) return [owner];
    return this.prisma.account.findMany({
      where: { redeemedByCard: cardKey, cardDisabled: false },
      include: { mailbox: true },
      orderBy: { id: 'asc' },
    });
  }

  /** 用户自带凭据永不关联库存；只有有效卡密可以读取和回写库内账号。 */
  private async preparePickupRecord(item: PickupRecordInput): Promise<PreparedPickupRecord> {
    const key = String(item?.key || item?.email || '').trim().toLowerCase();
    let account: AccountWithMailbox | null = null;
    let credential: MailboxCredential | null = null;
    let cardKey: string | null = null;
    if (typeof item?.line === 'string' && item.line.trim()) {
      credential = this.mailbox.parseCredential(item.line);
    } else if (typeof item?.fromCard === 'string' && item.fromCard.trim()) {
      const requestedCard = normalizeCardKey(item.fromCard);
      const accounts = await this.pickupAccountsForCard(requestedCard);
      const candidate = !key || normalizeCardKey(key) === requestedCard
        ? accounts.find((row) => row.cardKey === requestedCard)
        : accounts.find((row) => (row.mailbox?.email || row.email || row.name).toLowerCase() === key);
      if (candidate) {
        account = candidate;
        cardKey = requestedCard;
        credential = this.credentialOf(candidate);
      }
    }
    return {
      key: credential?.email || key,
      email: credential?.email || key,
      accountId: account?.id ?? null,
      cardKey,
      credential,
    };
  }

  // -------------------------------------------------------------------------
  // 取件：执行
  // -------------------------------------------------------------------------

  async fetchPickup(payload: {
    records?: PickupRecordInput[];
    maxMessages?: number;
    query?: string;
  }) {
    const settings = await this.settings.getAll();
    if (!Array.isArray(payload?.records)) bizError('BAD_INPUT', 'records 必须是取件记录数组');
    const incoming = payload.records.slice(0, MAX_PICKUP_RECORDS);
    const maxMessages = Math.min(
      50,
      Math.max(1, Number(payload?.maxMessages) || settings.pickupMaxMessages || 10),
    );

    const prepared: PreparedPickupRecord[] = [];
    for (const item of incoming) prepared.push(await this.preparePickupRecord(item));

    const results = await this.mailbox.pickupMany(
      prepared.map((item) => ({ key: item.key, credential: item.credential })),
      { maxMessages, query: payload?.query },
    );

    const enriched = results.map((result, index) => {
      const meta = prepared[index];
      return {
        ...result,
        key: meta?.key || result.key,
        accountId: meta?.accountId ?? null,
        cardKey: meta?.cardKey ?? null,
        error: meta?.credential ? result.error : '请提供有效卡密或完整邮箱凭据',
      };
    });

    // 命中的封禁/额度回写数据库
    for (const result of enriched) {
      if (!result.accountId || !result.ok || payload.query?.trim()) continue;
      try {
        await this.prisma.pickupLog.create({
          data: {
            accountId: result.accountId,
            email: result.email || result.key,
            ok: result.ok,
            banned: result.banned,
            credits: result.credits,
            code: result.latestCode,
            error: result.error,
          },
        });
        // 取件即定档：命中额度关键字 → 写回账号档位（0 = 仍未命中，保持原值）
        const tier = tierFromMailCredits(result.credits);
        await this.prisma.account.updateMany({
          // 无封禁邮件不构成解除既有封禁/失效状态的证据。
          where: {
            id: result.accountId,
            ...(result.banned ? {} : { banStatus: { notIn: ['banned', 'invalid'] } }),
          },
          data: {
            banStatus: result.banned ? 'banned' : 'normal',
            banReason: result.banned ? result.banReason : null,
            banKeywords: result.banned ? JSON.stringify(result.banKeywords) : null,
            banCheckedAt: new Date(),
          },
        });
        if (tier > 0) {
          await this.prisma.account.updateMany({ where: { id: result.accountId }, data: { credits: tier } });
        }
      } catch (error) {
        this.logger.warn(`回写取件结果失败：${error instanceof Error ? error.message : error}`);
      }
    }

    return {
      results: enriched.map((result) => ({
        ...result,
        /** 本次取件换算出的档位（未命中为 null） */
        tier: result.ok && tierFromMailCredits(result.credits) > 0 ? tierFromMailCredits(result.credits) : null,
      })),
      summary: this.mailbox.summarize(enriched),
    };
  }

  /** 导出同样需要卡密或自带凭据，禁止用邮箱 key 查询库内秘密。 */
  async exportPickup(payload: { records?: PickupRecordInput[]; kind?: string; category?: string }) {
    if (!Array.isArray(payload?.records) || payload.records.length > MAX_CARDS) {
      bizError('BAD_INPUT', `请提供 records（最多 ${MAX_CARDS} 条），每条包含卡密或完整凭据`);
    }
    const kind = payload?.kind === 'email' ? 'email' : 'line';
    const lines: string[] = [];
    for (const item of payload.records) {
      const prepared = await this.preparePickupRecord(item);
      if (kind === 'email') {
        if (looksEmail(prepared.email)) lines.push(prepared.email);
        continue;
      }
      const credential = prepared.credential;
      if (!this.mailbox.isComplete(credential)) {
        bizError('UNAUTHORIZED', '导出凭据需要有效卡密或用户自行提供的完整凭据', 403);
      }
      lines.push(
        credential.line ||
          [
            credential.email,
            credential.password || '',
            credential.clientId || '',
            credential.refreshToken || '',
          ].join('----'),
      );
    }

    return {
      content: `${lines.join('\n')}\n`,
      filename: payload.category && payload.category !== 'all'
        ? `pickup-${safeFilename(payload.category, 'export')}.txt`
        : `pickup-export-${kind}.txt`,
    };
  }
}

function tryJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
