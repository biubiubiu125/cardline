import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConvertService, readSub2ApiPassthrough } from '../convert/convert.service';
import { MailboxService } from '../mailbox/mailbox.service';
import { SettingsService } from '../settings/settings.service';
import { FORMAT_META } from '../common/error-codes';
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

const MAX_CARDS = 500;
const MAX_PICKUP_RECORDS = 20;

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly convert: ConvertService,
    private readonly mailbox: MailboxService,
    private readonly settings: SettingsService,
  ) {}

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
      formats: (['sub2api', 'cpa', 'email'] as const).map((value) => ({
        value,
        label: FORMAT_META[value].label,
        ext: FORMAT_META[value].ext,
        hint: FORMAT_META[value].hint,
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
    const format = ['sub2api', 'cpa', 'email'].includes(String(payload?.format))
      ? String(payload.format)
      : settings.defaultFormat || 'sub2api';

    const raw = Array.isArray(payload?.cards) ? payload.cards : [payload?.cards];
    let cards = [
      ...new Set(
        raw
          .flatMap((item) => splitTokens(item))
          .map((item) => normalizeCardKey(item))
          .filter(Boolean),
      ),
    ];
    if (cards.length > MAX_CARDS) {
      this.logger.warn(`单次提交卡密数量超限（${cards.length}），已截断为 ${MAX_CARDS}`);
      cards = cards.slice(0, MAX_CARDS);
    }

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
    }

    return {
      format,
      results,
      // 合并下载：sub2api / email 把所有成功账号并成一份文档。
      // CPA 没有合并形态（下游要一个个独立的 Codex auth 文件），前台改为打包 zip。
      mergedContent:
        format === 'cpa' || delivered.length === 0
          ? null
          : this.convert.buildDeliverContent(format, delivered),
      summary: {
        total: cards.length,
        success: successCount,
        failed: failedCount,
        credits: creditsSum,
        accounts: accountCount,
      },
    };
  }

  private async redeemOne(
    cardKey: string,
    format: string,
    limit: number,
    ip?: string,
    userAgent?: string,
  ): Promise<{ record: Record<string, unknown>; normalized: NormalizedAccount[] }> {
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
        const extra = await tx.account.findMany({
          where: {
            credits: account.credits,
            redeemStatus: 'unredeemed',
            redeemedByCard: null,
            banStatus: { notIn: ['banned', 'invalid'] },
            cardDisabled: false,
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: limit - 1,
        });
        if (extra.length) {
          await tx.account.updateMany({
            where: { id: { in: extra.map((item) => item.id) } },
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
      const normalized = accounts.map((item) => this.toNormalized(item));
      // 在事务内生成交付文件，转换异常会回滚本次库存占用。
      const content = this.convert.buildDeliverContent(format, normalized);
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
          filename: deliverFilename(cardKey, format),
          content,
          accounts: accounts.map((item) => ({
            id: item.id, name: item.name, credits: item.credits, planType: item.planType, email: item.email,
          })),
        },
      };
    }, { maxWait: 10000, timeout: 15000 });
    await this.log(cardKey, accountId, Number(result.record.credits) || 0, format, Boolean(result.record.ok), String(result.record.code), ip, userAgent);
    return result;
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
