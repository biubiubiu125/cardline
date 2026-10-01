import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConvertService, readSub2ApiPassthrough } from '../convert/convert.service';
import { MailboxService } from '../mailbox/mailbox.service';
import { SettingsService } from '../settings/settings.service';
import type { MailboxCredential, PickupResult } from '../mailbox/mailbox.types';
import type { NormalizedAccount } from '../convert/convert.types';
import {
  bizError,
  generateCardKey,
  looksEmail,
  mapWithConcurrency,
  normalizeCardKey,
  safeFilename,
  toDate,
  toIntArray,
  toPositiveInt,
  toStringArray,
} from '../common/utils';
import { PENDING_TIER, formatTier, isPendingTier, tierFromMailCredits } from '../common/credits';
import { FORMAT_META, isDeliverFormat, type DeliverFormat } from '../common/error-codes';
import { withReclaimLock } from '../public/reclaim-lock';
import { serializeStagedCredential, stagedExpiresAt, stagedForAccount } from '../public/staged-credential';
import { expiresAtFromJwt } from '../common/jwt-expiry';
import { zipStored } from '../common/zip-store';
import type { Account } from '@prisma/client';

function credentialExpiry(refreshed: { expiresAt?: Date | null; accessToken?: string | null }): Date | null {
  if (refreshed.expiresAt instanceof Date && !Number.isNaN(refreshed.expiresAt.getTime())) return refreshed.expiresAt;
  return expiresAtFromJwt(refreshed.accessToken);
}

const SORTABLE_FIELDS = new Set([
  'id',
  'name',
  'credits',
  'cardKey',
  'createdAt',
  'updatedAt',
  'banStatus',
  'banCheckedAt',
  'redeemStatus',
  'redeemedAt',
  'planType',
]);

/** 「批量复制卡密」单次上限：防止一次超大筛选把内存 / 剪贴板拉爆 */
const COPY_KEYS_DEFAULT = 5000;
const COPY_KEYS_MAX = 20000;

export interface AccountFilter {
  keyword?: string;
  credits?: unknown;
  banStatus?: unknown;
  redeemStatus?: unknown;
  cardKey?: string;
  batchId?: string;
  /** 卡密状态：active | disabled（后台卡密管理页使用） */
  status?: unknown;
}

export interface ListAccountsQuery extends AccountFilter {
  page?: number;
  pageSize?: number;
  sortField?: string;
  sortOrder?: string;
}

export interface AccountRow {
  id: number;
  name: string;
  email: string | null;
  credits: number;
  /** pending = 待定档（还没从邮件取件里定出额度），此时不进兑换池 */
  creditStatus: 'pending' | 'ready';
  cardKey: string;
  cardDisabled: boolean;
  planType: string | null;
  accountId: string | null;
  createdAt: string;
  updatedAt: string;
  banStatus: string;
  banReason: string | null;
  banKeywords: string[];
  banCheckedAt: string | null;
  redeemStatus: string;
  redeemedAt: string | null;
  redeemCount: number;
  copyCount: number;
  hasMailbox: boolean;
  mailboxEmail: string | null;
  batchId: string | null;
  remark: string | null;
}

type AccountWithMailbox = Account & {
  mailbox: { email: string; clientId: string | null; refreshToken: string | null } | null;
};

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly convert: ConvertService,
    private readonly mailbox: MailboxService,
    private readonly settings: SettingsService,
  ) {}

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  private buildWhere(filter: AccountFilter): Prisma.AccountWhereInput {
    const and: Prisma.AccountWhereInput[] = [];
    const credits = toIntArray(filter.credits);
    const banStatus = toStringArray(filter.banStatus);
    const redeemStatus = toStringArray(filter.redeemStatus);
    const status = toStringArray(filter.status);

    if (credits.length) and.push({ credits: { in: credits } });
    if (banStatus.length) and.push({ banStatus: { in: banStatus } });
    if (redeemStatus.length) and.push({ redeemStatus: { in: redeemStatus } });
    if (filter.batchId) and.push({ batchId: filter.batchId });
    if (status.length) {
      const only = status.filter((item) => item === 'active' || item === 'disabled');
      if (only.length === 1) and.push({ cardDisabled: only[0] === 'disabled' });
    }

    const keyword = String(filter.keyword ?? '').trim();
    if (keyword) {
      and.push({
        OR: [
          { name: { contains: keyword } },
          { email: { contains: keyword } },
          { cardKey: { contains: keyword } },
          { remark: { contains: keyword } },
        ],
      });
    }

    const cardKey = filter.cardKey ? normalizeCardKey(filter.cardKey) : '';
    if (cardKey) and.push({ cardKey });

    return and.length ? { AND: and } : {};
  }

  private toRow(account: AccountWithMailbox): AccountRow {
    let banKeywords: string[] = [];
    if (account.banKeywords) {
      try {
        const parsed = JSON.parse(account.banKeywords);
        if (Array.isArray(parsed)) banKeywords = parsed.map((item) => String(item));
      } catch {
        banKeywords = [];
      }
    }
    return {
      id: account.id,
      name: account.name,
      email: account.email,
      credits: account.credits,
      creditStatus: isPendingTier(account.credits) ? 'pending' : 'ready',
      cardKey: account.cardKey,
      cardDisabled: account.cardDisabled,
      planType: account.planType,
      accountId: account.accountId,
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
      banStatus: account.banStatus,
      banReason: account.banReason,
      banKeywords,
      banCheckedAt: account.banCheckedAt ? account.banCheckedAt.toISOString() : null,
      redeemStatus: account.redeemStatus,
      redeemedAt: account.redeemedAt ? account.redeemedAt.toISOString() : null,
      redeemCount: account.redeemCount,
      copyCount: account.copyCount,
      hasMailbox: Boolean(account.mailbox?.email),
      mailboxEmail: account.mailbox?.email ?? null,
      batchId: account.batchId,
      remark: account.remark,
    };
  }

  private async computeSummary(filter: AccountFilter) {
    const base = this.buildWhere(filter);
    const [total, unredeemed, redeemed, banned, invalid, unknown, pending, grouped] =
      await Promise.all([
        this.prisma.account.count({ where: base }),
        this.prisma.account.count({ where: { AND: [base, { redeemStatus: 'unredeemed' }] } }),
        this.prisma.account.count({ where: { AND: [base, { redeemStatus: 'redeemed' }] } }),
        this.prisma.account.count({ where: { AND: [base, { banStatus: 'banned' }] } }),
        this.prisma.account.count({ where: { AND: [base, { banStatus: 'invalid' }] } }),
        this.prisma.account.count({ where: { AND: [base, { banStatus: 'unknown' }] } }),
        this.prisma.account.count({ where: { AND: [base, { credits: PENDING_TIER }] } }),
        this.prisma.account.groupBy({
          by: ['credits', 'redeemStatus', 'banStatus'],
          where: base,
          _count: { _all: true },
        }),
      ]);

    // 档位完全由账号实际额度派生（0 = 待定档），没有手工维护的档位字典
    const byCreditsMap = new Map<
      number,
      { credits: number; total: number; unredeemed: number; redeemed: number; banned: number }
    >();
    const ensure = (credits: number) => {
      if (!byCreditsMap.has(credits)) {
        byCreditsMap.set(credits, { credits, total: 0, unredeemed: 0, redeemed: 0, banned: 0 });
      }
      return byCreditsMap.get(credits)!;
    };
    for (const group of grouped) {
      const entry = ensure(group.credits);
      const count = group._count._all;
      entry.total += count;
      if (group.redeemStatus === 'redeemed') entry.redeemed += count;
      else entry.unredeemed += count;
      if (group.banStatus === 'banned') entry.banned += count;
    }

    return {
      total,
      unredeemed,
      redeemed,
      banned,
      invalid,
      unknown,
      /** 待定档账号数（额度还没从邮件里定出来） */
      pending,
      byCredits: [...byCreditsMap.values()].sort((a, b) => a.credits - b.credits),
    };
  }

  /**
   * 额度档位分布（只读）。
   *
   * 档位 = 账号在导入后由邮箱取件命中额度关键字自动得出的结果，
   * 后台不提供新增/删除档位，这里只做展示与筛选。
   */
  async tiers() {
    const [grouped, pending] = await Promise.all([
      this.prisma.account.groupBy({
        by: ['credits', 'redeemStatus', 'banStatus', 'cardDisabled'],
        _count: { _all: true },
      }),
      this.prisma.account.count({ where: { credits: PENDING_TIER } }),
    ]);

    const map = new Map<
      number,
      {
        credits: number;
        label: string;
        accounts: number;
        available: number;
        redeemed: number;
        banned: number;
        disabled: number;
      }
    >();
    const ensure = (credits: number) => {
      if (!map.has(credits)) {
        map.set(credits, {
          credits,
          label: formatTier(credits),
          accounts: 0,
          available: 0,
          redeemed: 0,
          banned: 0,
          disabled: 0,
        });
      }
      return map.get(credits)!;
    };

    for (const group of grouped) {
      const entry = ensure(group.credits);
      const count = group._count._all;
      entry.accounts += count;
      if (group.redeemStatus === 'redeemed') entry.redeemed += count;
      if (group.banStatus === 'banned') entry.banned += count;
      if (group.cardDisabled) entry.disabled += count;
      const usable =
        group.redeemStatus === 'unredeemed' &&
        group.banStatus !== 'banned' &&
        group.banStatus !== 'invalid' &&
        !group.cardDisabled &&
        !isPendingTier(group.credits);
      if (usable) entry.available += count;
    }

    const items = [...map.values()].sort((a, b) => a.credits - b.credits);
    return { items, pending, total: items.reduce((sum, item) => sum + item.accounts, 0) };
  }

  async list(query: ListAccountsQuery) {
    const page = Math.max(1, toPositiveInt(query.page, 1));
    const pageSize = Math.min(200, Math.max(1, toPositiveInt(query.pageSize, 20)));
    const sortField = SORTABLE_FIELDS.has(String(query.sortField)) ? String(query.sortField) : 'createdAt';
    const sortOrder: Prisma.SortOrder =
      String(query.sortOrder).toLowerCase() === 'ascend' || String(query.sortOrder).toLowerCase() === 'asc'
        ? 'asc'
        : 'desc';

    const where = this.buildWhere(query);
    const [items, total, summary] = await Promise.all([
      this.prisma.account.findMany({
        where,
        include: { mailbox: { select: { email: true, clientId: true, refreshToken: true } } },
        orderBy: [{ [sortField]: sortOrder } as Prisma.AccountOrderByWithRelationInput, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.account.count({ where }),
      this.computeSummary(query),
    ]);

    return {
      items: items.map((item) => this.toRow(item)),
      total,
      page,
      pageSize,
      summary,
    };
  }

  async getById(id: number, withMailbox = true) {
    const account = await this.prisma.account.findUnique({
      where: { id },
      include: { mailbox: withMailbox },
    });
    if (!account) throw new NotFoundException({ code: 'NOT_FOUND', message: '账号不存在' });
    return account;
  }

  async summary(filter: AccountFilter = {}) {
    return this.computeSummary(filter);
  }

  // -------------------------------------------------------------------------
  // 导入
  // -------------------------------------------------------------------------

  /**
   * 批量导入账号。
   *
   * 注意：额度不在这里填写 —— 导入的账号一律先落到「待定档」（credits = 0），
   * 之后由邮箱取件命中额度关键字自动定档（见 refreshStatus 的 credits 目标）。
   */
  async importAccounts(payload: {
    content?: string;
    files?: Array<{ name?: string; content?: string }>;
    prefix?: string;
    remark?: string;
    source?: string;
    skipDuplicate?: boolean;
    keyGroups?: number;
    keyLength?: number;
  }) {
    const sources: Array<{ name: string; content: string }> = [];
    if (payload?.content && String(payload.content).trim()) {
      sources.push({ name: 'pasted-json', content: String(payload.content) });
    }
    for (const file of payload?.files || []) {
      if (file?.content && String(file.content).trim()) {
        sources.push({ name: file.name || 'uploaded-file', content: String(file.content) });
      }
    }
    if (!sources.length) bizError('BAD_INPUT', '请粘贴 JSON 内容或上传文件');

    const skipDuplicate = payload?.skipDuplicate !== false;
    const prefix = (payload?.prefix || process.env.CARD_PREFIX || 'CARD').trim();
    const keyGroups = Math.min(5, Math.max(2, toPositiveInt(payload?.keyGroups, 3)));
    const keyLength = Math.min(8, Math.max(3, toPositiveInt(payload?.keyLength, 5)));
    const source = payload?.source === 'upload' ? 'upload' : sources.length && payload?.content ? 'paste' : 'upload';

    // 全量解析
    const parsedItems: Array<{
      account: NormalizedAccount;
      sourcePath: string;
      sourceName: string;
    }> = [];
    const errors: Array<{ index: number; name: string; reason: string }> = [];
    let index = 0;

    for (const doc of sources) {
      const result = this.convert.parseAccounts(doc.content, doc.name);
      for (const item of result.items) {
        parsedItems.push({
          account: item.account,
          sourcePath: item.sourcePath,
          sourceName: item.source,
        });
        index++;
      }
      for (const issue of result.issues) {
        errors.push({
          index: index++,
          name: issue.source || doc.name,
          reason: issue.reason,
        });
      }
    }

    if (!parsedItems.length) {
      bizError('BAD_INPUT', '未解析出任何账号，请检查 JSON 格式（需要包含 access_token 的账号对象）', 400, {
        errors,
      });
    }

    // 去重（本次提交内）
    const seen = new Set<string>();
    const unique: typeof parsedItems = [];
    let skipped = 0;
    for (const item of parsedItems) {
      const key = this.dedupeKey(item.account);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      unique.push(item);
    }

    // 与数据库比对去重
    let toInsert = unique;
    if (skipDuplicate) {
      const emails = [
        ...new Set(
          unique
            .map((item) => item.account.mailbox?.email || item.account.email)
            .filter((value): value is string => Boolean(value))
            .map((value) => value.toLowerCase()),
        ),
      ];
      const names = [
        ...new Set(
          unique
            .map((item) => item.account.name)
            .filter((value): value is string => Boolean(value) && !value.includes('----')),
        ),
      ];
      const existing = emails.length || names.length
        ? await this.prisma.account.findMany({
            where: {
              OR: [
                ...(emails.length ? [{ email: { in: emails } }] : []),
                ...(names.length ? [{ name: { in: names } }] : []),
              ],
            },
            select: { email: true, name: true },
          })
        : [];
      const existingEmails = new Set(
        existing.map((row) => (row.email || '').toLowerCase()).filter(Boolean),
      );
      const existingNames = new Set(existing.map((row) => row.name).filter(Boolean));
      toInsert = unique.filter((item) => {
        const email = (item.account.mailbox?.email || item.account.email || '').toLowerCase();
        const name = item.account.name || '';
        if ((email && existingEmails.has(email)) || (name && existingNames.has(name))) {
          skipped++;
          return false;
        }
        return true;
      });
    }

    const batchId = await this.uniqueBatchId();
    const now = new Date();
    let imported = 0;
    const cards: string[] = [];
    const samples: Array<{ id: number; name: string; cardKey: string; credits: number }> = [];

    await this.prisma.batch.create({
      data: {
        batchId,
        credits: PENDING_TIER,
        count: 0,
        remark: payload?.remark || null,
        source,
        createdAt: now,
      },
    });

    for (const item of toInsert) {
      const account = item.account;
      try {
        const cardKey = await this.uniqueCardKey(prefix, keyGroups, keyLength);
        const created = await this.prisma.account.create({
          data: {
            name: account.name,
            email: account.email || account.mailbox?.email || null,
            credits: PENDING_TIER,
            cardKey,
            planType: account.planType || null,
            accountId: account.accountId || null,
            userId: account.userId || null,
            accessToken: account.accessToken,
            refreshToken: account.refreshToken || null,
            idToken: account.idToken || null,
            sessionToken: account.sessionToken || null,
            expiresAt: toDate(account.expiresAt) || null,
            rawSource: account.rawSource,
            rawJson: account.raw ? JSON.stringify(account.raw) : null,
            banStatus: 'unknown',
            redeemStatus: 'unredeemed',
            batchId,
            remark: payload?.remark || null,
            mailbox: account.mailbox?.email
              ? {
                  create: {
                    email: account.mailbox.email,
                    provider: account.mailbox.provider || 'outlook',
                    authType: account.mailbox.authType || 'oauth2',
                    password: account.mailbox.password || null,
                    clientId: account.mailbox.clientId || null,
                    refreshToken: account.mailbox.refreshToken || null,
                    line: account.mailbox.line || null,
                    imapHost: account.mailbox.imapHost || 'outlook.office365.com',
                    imapPort: account.mailbox.imapPort || 993,
                  },
                }
              : undefined,
          },
        });
        imported++;
        cards.push(cardKey);
        if (samples.length < 50) {
          samples.push({
            id: created.id,
            name: created.name,
            cardKey: created.cardKey,
            credits: created.credits,
          });
        }
      } catch (error) {
        errors.push({
          index: index++,
          name: account.name,
          reason: error instanceof Error ? error.message : '写入失败',
        });
      }
    }

    await this.prisma.batch.update({
      where: { batchId },
      data: { count: imported },
    });

    this.logger.log(`导入批次 ${batchId}：成功 ${imported}，跳过 ${skipped}，失败 ${errors.length}`);

    return {
      batchId,
      imported,
      skipped,
      failed: errors.length,
      cards,
      credits: PENDING_TIER,
      /** 待定档数量（= 本次导入数，额度需取件后才能得出） */
      pending: imported,
      errors: errors.slice(0, 200),
      samples,
    };
  }

  private async uniqueBatchId(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = `b_${timestampToken()}_${Math.random().toString(36).slice(2, 6)}`;
      const exists = await this.prisma.batch.findUnique({ where: { batchId: candidate } });
      if (!exists) return candidate;
    }
    return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private dedupeKey(account: NormalizedAccount): string {
    return [
      (account.mailbox?.email || account.email || account.name || '').toLowerCase(),
      account.mailbox?.refreshToken || account.refreshToken || '',
      account.accessToken.slice(-24),
    ].join('|');
  }

  private async uniqueCardKey(prefix: string, groups: number, length: number): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = generateCardKey(prefix, groups, length);
      const exists = await this.prisma.account.findUnique({ where: { cardKey: candidate } });
      if (!exists) return candidate;
    }
    // 兜底：追加时间戳后缀
    return `${generateCardKey(prefix, groups, length)}-${Date.now().toString(36).toUpperCase()}`;
  }

  // -------------------------------------------------------------------------
  // 更新 / 删除
  // -------------------------------------------------------------------------

  async update(id: number, patch: Record<string, unknown>) {
    const current = await this.getById(id, false);
    const data: Prisma.AccountUpdateManyMutationInput = {};

    if (patch.remark !== undefined) data.remark = patch.remark === null ? null : String(patch.remark);
    // 兜底通道：额度正常由邮箱取件自动定档，这里只作为「人工纠错」的最后手段保留。
    // 传 0 可以把账号退回待定档（不再进兑换池）。
    if (patch.credits !== undefined) {
      const credits = Number(patch.credits);
      if (!Number.isFinite(credits) || credits < 0) bizError('BAD_INPUT', '额度必须是非负整数（0 = 待定档）');
      data.credits = Math.trunc(credits);
    }
    if (patch.banStatus !== undefined) {
      const status = String(patch.banStatus);
      if (!['unknown', 'normal', 'banned', 'invalid'].includes(status)) {
        bizError('BAD_INPUT', `不支持的封禁状态：${status}`);
      }
      data.banStatus = status;
      data.banCheckedAt = new Date();
      data.banReason = status === 'banned' ? String(patch.banReason || '管理员手动标记') : null;
    }
    if (patch.redeemStatus !== undefined) {
      const status = String(patch.redeemStatus);
      if (!['unredeemed', 'redeemed'].includes(status)) {
        bizError('BAD_INPUT', `不支持的兑换状态：${status}`);
      }
      data.redeemStatus = status;
      data.redeemedAt = status === 'redeemed' ? new Date() : null;
      if (status === 'redeemed' && !current.redeemedByCard) data.redeemedByCard = current.cardKey;
    }

    const changed = await this.prisma.account.updateMany({
      where: { id, ...(data.redeemStatus === 'unredeemed' ? { redeemedByCard: null } : {}) },
      data,
    });
    if (!changed.count) bizError('CONFLICT', '已交付账号不能重置为未兑换，避免重复出售');
    return this.toRow(await this.getById(id, true));
  }

  async batchDelete(ids: number[]) {
    const list = (ids || []).map((id) => Number(id)).filter((id) => Number.isFinite(id));
    if (!list.length) bizError('BAD_INPUT', '请选择要删除的账号');
    const result = await this.prisma.account.deleteMany({ where: { id: { in: list } } });
    return { deleted: result.count };
  }

  async copyCard(id: number) {
    const account = await this.getById(id, false);
    const updated = await this.prisma.account.update({
      where: { id },
      data: { copyCount: { increment: 1 } },
    });
    return { id: account.id, cardKey: updated.cardKey, copyCount: updated.copyCount };
  }

  async generateCards(payload: { ids?: number[]; prefix?: string; regenerate?: boolean }) {
    const prefix = (payload?.prefix || process.env.CARD_PREFIX || 'CARD').trim();
    const ids = (payload?.ids || []).map((id) => Number(id)).filter((id) => Number.isFinite(id));
    const accounts = await this.prisma.account.findMany({
      where: ids.length ? { id: { in: ids } } : {},
      select: { id: true, cardKey: true, redeemStatus: true, redeemedByCard: true },
    });
    if (payload?.regenerate && accounts.some((account) => account.redeemStatus === 'redeemed' || account.redeemedByCard)) {
      bizError('CONFLICT', '已兑换账号不能重新生成卡密，原卡密需要保留用于重复下载');
    }
    let updated = 0;
    for (const account of accounts) {
      if (account.cardKey && !payload?.regenerate) continue;
      const cardKey = await this.uniqueCardKey(prefix, 3, 5);
      const changed = await this.prisma.account.updateMany({
        where: { id: account.id, cardKey: account.cardKey, redeemStatus: 'unredeemed', redeemedByCard: null },
        data: { cardKey },
      });
      if (!changed.count) bizError('CONFLICT', '账号状态已变化，请刷新后重试');
      updated++;
    }
    return { updated };
  }

  // -------------------------------------------------------------------------
  // 模型转换
  // -------------------------------------------------------------------------

  private toNormalizedAccount(account: Account & { mailbox?: any }): NormalizedAccount {
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
        ? {
            email: account.email,
            provider: 'outlook',
            authType: 'oauth2',
            line: [account.email, '', '', ''].join('----'),
          }
        : undefined;

    const staged = stagedForAccount(account);
    const expiresAt = staged ? stagedExpiresAt(staged.expiresAt) : account.expiresAt;
    return {
      name: account.name,
      email: account.email || undefined,
      planType: account.planType || undefined,
      accountId: account.accountId || undefined,
      userId: account.userId || undefined,
      accessToken: staged?.accessToken || account.accessToken,
      refreshToken: staged?.refreshToken || account.refreshToken || undefined,
      idToken: staged?.idToken || account.idToken || undefined,
      sessionToken: account.sessionToken || undefined,
      expiresAt: expiresAt ? expiresAt.toISOString() : undefined,
      accessTokenExpiresAt: expiresAt ? Math.trunc(expiresAt.getTime() / 1000) : undefined,
      rawSource: (account.rawSource as 'sub2api' | 'cpa') || 'sub2api',
      raw,
      mailbox,
      // extra（含 two_factor_*）/ concurrency / rate_multiplier 等只存在 rawJson 里，
      // 不回填的话导出文件会丢掉这些字段
      ...readSub2ApiPassthrough(raw),
    };
  }

  async buildExportContent(
    format: string,
    rows: Array<Account & { mailbox?: any }>,
    now = new Date(),
  ): Promise<{ content: string; filename: string; contentType: string }> {
    const normalized = rows.map((row) => this.toNormalizedAccount(row));
    const content = this.convert.buildDeliverContent(format, normalized, now);
    const ext = isDeliverFormat(format) ? FORMAT_META[format].ext : format === 'email' ? 'txt' : 'json';
    const contentType =
      ext === 'txt'
        ? 'text/plain; charset=utf-8'
        : 'application/json; charset=utf-8';
    return { content, filename: `accounts-${format}.${ext}`, contentType };
  }

  /** 导出前把仍匹配的暂存凭据写成当前凭据。同卡已有未完成标记时，这份凭据也保持不轮换。 */
  private async persistStagedExports(rows: Array<Account & { mailbox?: any }>): Promise<void> {
    const owners = [
      ...new Set(rows.filter((row) => stagedForAccount(row)).map((row) => row.redeemedByCard || row.cardKey)),
    ];
    for (const owner of owners) {
      try {
        await withReclaimLock(this.prisma, owner, async () => {
          const selected = new Set(rows.map((row) => row.id));
          const current = await this.prisma.account.findMany({
            where: { OR: [{ redeemedByCard: owner }, { cardKey: owner }] },
          });
          const held = current.some((item) => item.refreshHeld);
          for (const item of current) {
            if (!selected.has(item.id)) continue;
            const staged = stagedForAccount(item);
            if (!staged || !item.refreshToken) continue;
            await this.prisma.account.updateMany({
              where: { id: item.id, refreshToken: item.refreshToken },
              data: {
                accessToken: staged.accessToken,
                refreshToken: staged.refreshToken,
                idToken: staged.idToken,
                expiresAt: stagedExpiresAt(staged.expiresAt),
                stagedCredential: null,
                ...(held ? { refreshHeld: true } : {}),
              },
            });
          }
        });
      } catch {
        this.logger.warn('导出时提交暂存凭据失败，文件仍按暂存凭据生成');
      }
    }
  }

  /** 后台导出：按筛选条件或指定 id 导出 */
  async exportAccounts(payload: {
    format?: string;
    filter?: AccountFilter;
    ids?: number[];
    filename?: string;
    limit?: number;
  }) {
    const format: DeliverFormat = isDeliverFormat(payload?.format) ? payload.format : 'sub2api';
    const ids = (payload?.ids || []).map((id) => Number(id)).filter((id) => Number.isFinite(id));
    const limit = Math.min(5000, Math.max(1, toPositiveInt(payload?.limit, 2000)));

    const rows = await this.prisma.account.findMany({
      where: ids.length ? { id: { in: ids } } : this.buildWhere(payload?.filter || {}),
      include: { mailbox: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    await this.persistStagedExports(rows);
    const fresh = rows.length
      ? await this.prisma.account.findMany({
          where: { id: { in: rows.map((row) => row.id) } },
          include: { mailbox: true },
          orderBy: { id: 'asc' },
        })
      : rows;

    const sessionFiles = new Set(['cockpit', 'ninerouter', 'codex', 'axonhub', 'codex-manager']);
    if (sessionFiles.has(format) && fresh.length > 1) {
      const normalized = fresh.map((row) => this.toNormalizedAccount(row));
      const stem = safeFilename(payload?.filename || `accounts-${format}`, `accounts-${format}`);
      return {
        content: zipStored(
          normalized.map((account, index) => {
            const label = safeFilename(account.email || account.name || String(index + 1), String(index + 1));
            return {
              name: `${stem}-${index + 1}-${label}.${format}.json`,
              content: this.convert.buildDeliverContent(format, [account]),
            };
          }),
        ),
        filename: `${stem}.zip`,
        contentType: 'application/zip',
      };
    }
    const base = await this.buildExportContent(format, fresh);
    return {
      ...base,
      filename: `${safeFilename(payload?.filename || `accounts-${format}`, `accounts-${format}`)}.${FORMAT_META[format].ext}`,
    };
  }

  // -------------------------------------------------------------------------
  // 状态刷新
  // -------------------------------------------------------------------------

  private resolveCredential(account: Account & { mailbox?: any }): MailboxCredential | null {
    if (account.mailbox?.email) {
      const credential = this.mailbox.parseCredential({
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
      // 凭据完整时优先使用；不完整也返回，便于前端提示缺失项
      if (credential && this.mailbox.isComplete(credential)) return credential;
      if (account.email && looksEmail(account.email)) {
        return credential || this.mailbox.parseCredential(account.email);
      }
      return credential;
    }
    if (account.email && looksEmail(account.email)) {
      return this.mailbox.parseCredential(account.email);
    }
    return null;
  }

  /**
   * 取件（后台侧）：一次取件同时产出「封禁状态」和「额度档位」。
   *
   * 额度只认邮件命中的关键字，命中即写回 `Account.credits`（档位 = 命中 credits ÷ 25）；
   * 没有命中就保持原值（导入时为 0 = 待定档），不会覆盖已有档位。
   */
  private async pickupAccount(
    account: Account & { mailbox?: any },
    options: { maxMessages?: number } = {},
  ): Promise<{
    /** 取件本身是否成功（凭据失效 / 网络错误 = false） */
    ok: boolean;
    banStatus: string;
    banReason: string | null;
    banKeywords: string[];
    /** 本次邮件命中的原始 credits（未换算） */
    mailCredits: number | null;
    /** 换算后的档位；null 表示本次没命中 */
    tier: number | null;
    error: string | null;
  }> {
    const credential = this.resolveCredential(account);
    const result = await this.mailbox.pickupOne(credential, {
      maxMessages: options.maxMessages || 10,
    });

    if (!result.ok) {
      // 凭据失效属于「凭据失效」，不是「封禁」
      const invalid =
        /invalid_grant|unauthorized_client|invalid_client|无权读取|exchange|换 token 失败/i.test(
          result.error || '',
        );
      if (invalid) {
        await this.prisma.account.update({
          where: { id: account.id },
          data: {
            banStatus: 'invalid',
            banReason: result.error,
            banCheckedAt: new Date(),
          },
        });
        return {
          ok: false,
          banStatus: 'invalid',
          banReason: result.error,
          banKeywords: [],
          mailCredits: null,
          tier: null,
          error: null,
        };
      }
      // 网络/上游问题：保持原状态
      await this.prisma.account.update({
        where: { id: account.id },
        data: { banReason: result.error, banCheckedAt: new Date() },
      });
      return {
        ok: false,
        banStatus: account.banStatus,
        banReason: account.banReason,
        banKeywords: [],
        mailCredits: null,
        tier: null,
        error: result.error,
      };
    }

    const banStatus = result.banned ? 'banned' : 'normal';
    const banReason = result.banned ? result.banReason : null;
    // 命中额度 → 自动定档（待定档 0 表示还没定出来）
    const tier = tierFromMailCredits(result.credits);

    await this.prisma.account.update({
      where: { id: account.id },
      data: {
        banStatus,
        banReason,
        banKeywords: result.banned ? JSON.stringify(result.banKeywords) : null,
        banCheckedAt: new Date(),
        ...(tier > PENDING_TIER ? { credits: tier } : {}),
      },
    });
    await this.prisma.pickupLog.create({
      data: {
        accountId: account.id,
        email: result.email || account.email || account.name,
        ok: true,
        banned: result.banned,
        credits: result.credits,
        code: result.latestCode,
        error: null,
      },
    });

    this.logger.log(
      `取件定档 #${account.id} ${account.name}：邮件命中 ${result.credits ?? '无'} credits → 档位 ${
        tier > PENDING_TIER ? tier : '待定档'
      }`,
    );

    return {
      ok: true,
      banStatus,
      banReason,
      banKeywords: result.banKeywords,
      mailCredits: result.credits ?? null,
      tier: tier > PENDING_TIER ? tier : null,
      error: null,
    };
  }

  /** 凭据健康检查不推断交易行为，兑换状态只由交付或管理员操作改变。 */
  private async refreshRedeem(
    account: Account & { mailbox?: any },
  ): Promise<{
    redeemStatus: string;
    redeemedAt: string | null;
    error: string | null;
    unsavedCredential?: { accessToken: string; refreshToken: string; idToken: string | null; expiresAt: string | null } | null;
  }> {
    return withReclaimLock(this.prisma, account.redeemedByCard || account.cardKey, () => this.refreshRedeemLocked(account.id));
  }

  private async refreshRedeemLocked(
    accountId: number,
  ): Promise<{
    redeemStatus: string;
    redeemedAt: string | null;
    error: string | null;
    unsavedCredential?: { accessToken: string; refreshToken: string; idToken: string | null; expiresAt: string | null } | null;
  }> {
    let account = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!account) return { redeemStatus: 'unredeemed', redeemedAt: null, error: '账号不存在' };
    const staged = stagedForAccount(account);
    if (staged && account.refreshToken) {
      const owner = account.redeemedByCard || account.cardKey;
      const held = await this.prisma.account.count({
        where: { redeemedByCard: owner, refreshHeld: true },
      });
      const applied = await this.prisma.account.updateMany({
        where: { id: account.id, refreshToken: account.refreshToken },
        data: {
          accessToken: staged.accessToken,
          refreshToken: staged.refreshToken,
          idToken: staged.idToken,
          expiresAt: stagedExpiresAt(staged.expiresAt),
          stagedCredential: null,
          ...(held > 0 ? { refreshHeld: true } : {}),
        },
      });
      if (!applied.count) {
        return {
          redeemStatus: account.redeemStatus,
          redeemedAt: account.redeemedAt?.toISOString() || null,
          error: '凭据已被其他操作更新，未写入',
        };
      }
      account = await this.prisma.account.findUnique({ where: { id: accountId } });
      if (!account) return { redeemStatus: 'unredeemed', redeemedAt: null, error: '账号不存在' };
    }
    const result = (
      error: string | null = null,
      unsavedCredential: { accessToken: string; refreshToken: string; idToken: string | null; expiresAt: string | null } | null = null,
    ) => ({
      redeemStatus: account.redeemStatus,
      redeemedAt: account.redeemedAt?.toISOString() || null,
      error,
      unsavedCredential,
    });
    let expiresAt = account.expiresAt?.getTime();
    if (!Number.isFinite(expiresAt)) {
      try {
        const claims = JSON.parse(Buffer.from(account.accessToken.split('.')[1], 'base64url').toString());
        if (Number.isFinite(claims.exp)) expiresAt = claims.exp * 1000;
      } catch {
        // 未知有效期不能作为已兑换或凭据失效的证据。
      }
    }
    if (!Number.isFinite(expiresAt)) return result('无法确定 access_token 有效期，未自动刷新');
    if (expiresAt > Date.now()) return result();

    // MailCredential.refreshToken 属于微软 OAuth，绝不能发送给 OpenAI。
    if (!account.refreshToken) return result('缺少 OpenAI refresh_token，无法刷新过期凭据');
    const previousRefreshToken = account.refreshToken;
    const refreshed = await this.mailbox.refreshOpenAiToken(previousRefreshToken);
    if (!refreshed.ok) {
      if (refreshed.invalidCredential) {
        await this.prisma.account.updateMany({
          where: { id: account.id, refreshToken: previousRefreshToken, banStatus: { not: 'banned' } },
          data: { banStatus: 'invalid', banReason: refreshed.error, banCheckedAt: new Date() },
        });
      }
      return result(refreshed.error || '刷新失败');
    }

    // 条件写回避免覆盖并发更新。写库抛错也要暂存，否则下次还会拿旧 refresh token 去刷新。
    const nextRefreshToken = refreshed.refreshToken || previousRefreshToken;
    const nextAccessToken = refreshed.accessToken!;
    const nextIdToken = refreshed.idToken || account.idToken || null;
    const nextExpiry = credentialExpiry(refreshed);
    let persisted = false;
    let stagedAside = false;
    for (let attempt = 0; attempt < 2 && !persisted && !stagedAside; attempt += 1) {
      try {
        const changed = await this.prisma.account.updateMany({
          where: { id: account.id, refreshToken: previousRefreshToken },
          data: {
            accessToken: nextAccessToken,
            refreshToken: nextRefreshToken,
            idToken: nextIdToken,
            expiresAt: nextExpiry,
            stagedCredential: null,
          },
        });
        if (changed.count) {
          persisted = true;
          break;
        }
      } catch {
        // 写成当前凭据失败时改为暂存，不能把异常直接抛出。
      }
      try {
        const current = await this.prisma.account.findUnique({ where: { id: account.id } });
        if (current?.refreshToken === nextRefreshToken && current.accessToken === nextAccessToken) {
          persisted = true;
          break;
        }
        if (current?.refreshToken !== previousRefreshToken) {
          return result('凭据已被其他操作更新，未写入');
        }
        const saved = await this.prisma.account.updateMany({
          where: { id: account.id, refreshToken: previousRefreshToken },
          data: {
            stagedCredential: serializeStagedCredential({
              accessToken: nextAccessToken,
              refreshToken: nextRefreshToken,
              idToken: nextIdToken,
              expiresAt: nextExpiry,
              previousRefreshToken,
            }),
          },
        });
        if (saved.count) stagedAside = true;
      } catch {
        // 暂存也失败就再试一次，仍然不请求 OpenAI。
      }
    }
    if (persisted) return result();
    if (stagedAside) return result('凭据已刷新但没有写成当前凭据，已暂存，请再检查一次');
    return result('凭据已刷新，但没有写入数据库。请立即保存本次结果，旧刷新凭据可能已经失效', {
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      idToken: nextIdToken,
      expiresAt: nextExpiry ? nextExpiry.toISOString() : null,
    });
  }

  /**
   * 批量刷新状态。
   *
   * targets：
   *  - `ban`     取件扫描封禁关键词
   *  - `redeem`  刷新已过期的 OpenAI 凭据，保留实际交付状态
   *  - `credits` 取件命中额度关键字 → 自动定档（额度只来自邮件，不接受人工填写）
   *
   * `credits` 与 `ban` 共用同一次取件结果（不会重复请求邮箱）。
   * 传入 `cursor`（上一轮返回的 nextCursor）可以按 id 递增分批推进，
   * 保证「取件成功但没命中额度」的账号不会被同一轮反复重复取件。
   */
  async refreshStatus(payload: {
    ids?: number[];
    filter?: AccountFilter;
    targets?: string[];
    limit?: number;
    /** 只处理 id > cursor 的账号（配合响应里的 nextCursor 循环调用） */
    cursor?: number;
  }) {
    const targets = toStringArray(payload?.targets).filter(
      (item) => item === 'ban' || item === 'redeem' || item === 'credits',
    );
    const effectiveTargets = targets.length ? targets : ['ban', 'redeem'];
    const limit = Math.min(500, Math.max(1, toPositiveInt(payload?.limit, 100)));
    const ids = (payload?.ids || []).map((id) => Number(id)).filter((id) => Number.isFinite(id));
    const cursor = Number(payload?.cursor);
    const hasCursor = Number.isFinite(cursor) && cursor > 0;
    const needPickup = effectiveTargets.includes('ban') || effectiveTargets.includes('credits');

    const base = ids.length ? { id: { in: ids } } : this.buildWhere(payload?.filter || {});
    const where = hasCursor ? { AND: [base, { id: { gt: cursor } }] } : base;
    const accounts = await this.prisma.account.findMany({
      where,
      include: { mailbox: true },
      orderBy: { id: 'asc' },
      take: ids.length ? Math.max(ids.length, 1) : limit,
    });

    const banCounter = { banned: 0, normal: 0, invalid: 0, failed: 0 };
    const redeemCounter = { redeemed: 0, unredeemed: 0, failed: 0 };
    const creditsCounter = { hit: 0, pending: 0, failed: 0 };
    const items: Array<Record<string, unknown>> = [];

    await mapWithConcurrency(accounts, Math.min(4, accounts.length || 1), async (account) => {
      const entry: Record<string, unknown> = {
        id: account.id,
        name: account.name,
        banStatus: account.banStatus,
        banReason: account.banReason,
        credits: account.credits,
        creditStatus: isPendingTier(account.credits) ? 'pending' : 'ready',
        redeemStatus: account.redeemStatus,
        redeemedAt: account.redeemedAt ? account.redeemedAt.toISOString() : null,
        error: null,
      };
      const errors: string[] = [];
      let banFailed = false;
      let redeemFailed = false;

      if (needPickup) {
        try {
          const pickup = await this.pickupAccount(account);
          if (effectiveTargets.includes('ban')) {
            entry.banStatus = pickup.banStatus;
            entry.banReason = pickup.banReason;
            entry.banKeywords = pickup.banKeywords;
            if (pickup.error) {
              errors.push(pickup.error);
              banFailed = true;
            }
          } else if (pickup.error) {
            errors.push(pickup.error);
          }

          if (effectiveTargets.includes('credits')) {
            if (pickup.tier !== null) {
              creditsCounter.hit++;
              entry.credits = pickup.tier;
              entry.creditStatus = 'ready';
              entry.mailCredits = pickup.mailCredits;
            } else if (!pickup.ok) {
              // 取件本身失败（凭据失效 / 网络）：不是「没收到额度邮件」，单独计数
              creditsCounter.failed++;
              entry.credits = account.credits;
              entry.creditStatus = isPendingTier(account.credits) ? 'pending' : 'ready';
            } else {
              creditsCounter.pending++;
              entry.credits = account.credits;
              entry.creditStatus = isPendingTier(account.credits) ? 'pending' : 'ready';
            }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : '取件失败';
          errors.push(reason);
          banFailed = true;
          if (effectiveTargets.includes('credits')) creditsCounter.failed++;
        }
      }

      if (effectiveTargets.includes('redeem')) {
        try {
          const redeem = await this.refreshRedeem(account);
          entry.redeemStatus = redeem.redeemStatus;
          entry.redeemedAt = redeem.redeemedAt;
          if (redeem.unsavedCredential) entry.unsavedCredential = redeem.unsavedCredential;
          if (redeem.error) {
            errors.push(redeem.error);
            redeemFailed = true;
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : '刷新兑换状态失败');
          redeemFailed = true;
        }
      }

      const fresh = await this.prisma.account.findUnique({ where: { id: account.id } });
      if (fresh) {
        Object.assign(entry, {
          banStatus: fresh.banStatus,
          banReason: fresh.banReason,
          redeemStatus: fresh.redeemStatus,
          redeemedAt: fresh.redeemedAt?.toISOString() || null,
          credits: fresh.credits,
          creditStatus: isPendingTier(fresh.credits) ? 'pending' : 'ready',
        });
      }
      if (effectiveTargets.includes('ban')) {
        if (banFailed || !fresh) banCounter.failed++;
        else if (fresh.banStatus === 'banned') banCounter.banned++;
        else if (fresh.banStatus === 'invalid') banCounter.invalid++;
        else banCounter.normal++;
      }
      if (effectiveTargets.includes('redeem')) {
        if (redeemFailed || !fresh) redeemCounter.failed++;
        else if (fresh.redeemStatus === 'redeemed') redeemCounter.redeemed++;
        else redeemCounter.unredeemed++;
      }
      entry.error = errors.length ? errors.join('；') : null;
      items.push(entry);
    });

    items.sort((a, b) => Number(a.id) - Number(b.id));
    const lastId = accounts.length ? accounts[accounts.length - 1].id : null;

    return {
      requested: ids.length || accounts.length,
      processed: accounts.length,
      /** 下一轮的 cursor；null 表示这批已经处理完 */
      nextCursor: hasCursor || !ids.length ? lastId : null,
      ban: effectiveTargets.includes('ban') ? banCounter : undefined,
      redeem: effectiveTargets.includes('redeem') ? redeemCounter : undefined,
      credits: effectiveTargets.includes('credits') ? creditsCounter : undefined,
      items,
    };
  }

  // -------------------------------------------------------------------------
  // 取件弹窗
  // -------------------------------------------------------------------------

  async getMailbox(id: number, query: { maxMessages?: number; refresh?: string } = {}) {
    const account = await this.getById(id, true);
    const withMailbox = account as AccountWithMailbox;
    const credential = this.resolveCredential(withMailbox);
    const maxMessages = Math.min(50, Math.max(1, toPositiveInt(query?.maxMessages, 10)));

    let pickup: PickupResult;
    if (!this.mailbox.isComplete(credential)) {
      pickup = {
        key: credential?.email || account.email || account.name,
        email: credential?.email || account.email || account.name,
        ok: false,
        error: credential
          ? '该账号缺少完整的邮箱取件凭据（需要 client_id 与 refresh_token）'
          : '该账号没有邮箱取件凭据',
        banned: false,
        banReason: null,
        banKeywords: [],
        credits: null,
        creditsBalance: null,
        latestCode: null,
        fetchedAt: new Date().toISOString(),
        messages: [],
      };
    } else {
      pickup = await this.mailbox.pickupOne(credential, { maxMessages });
      await this.prisma.pickupLog.create({
        data: {
          accountId: account.id,
          email: pickup.email || account.name,
          ok: pickup.ok,
          banned: pickup.banned,
          credits: pickup.credits,
          code: pickup.latestCode,
          error: pickup.error,
        },
      });
      if (pickup.ok) {
        // 取件即定档：邮件命中额度关键字 → 写回账号档位（0 表示仍未命中）
        const tier = tierFromMailCredits(pickup.credits);
        await this.prisma.account.update({
          where: { id: account.id },
          data: {
            banStatus: pickup.banned ? 'banned' : 'normal',
            banReason: pickup.banned ? pickup.banReason : null,
            banKeywords: pickup.banned ? JSON.stringify(pickup.banKeywords) : null,
            banCheckedAt: new Date(),
            ...(tier > PENDING_TIER ? { credits: tier } : {}),
          },
        });
      }
    }

    const fresh = await this.prisma.account.findUnique({
      where: { id },
      include: { mailbox: { select: { email: true, clientId: true, refreshToken: true } } },
    });

    return {
      account: this.toRow((fresh || withMailbox) as AccountWithMailbox),
      mailbox: credential
        ? {
            email: credential.email,
            provider: credential.provider,
            authType: credential.authType,
            imapHost: credential.imapHost,
            imapPort: credential.imapPort,
            password: credential.password || null,
            clientId: credential.clientId || null,
            refreshToken: credential.refreshToken || null,
            line: credential.line || null,
          }
        : null,
      pickup,
      messages: pickup.messages,
    };
  }

  // -------------------------------------------------------------------------
  // 卡密管理（映射 Account）
  // -------------------------------------------------------------------------

  async listCards(query: ListAccountsQuery) {
    const result = await this.list(query);
    return {
      items: result.items.map((row) => ({
        id: row.id,
        cardKey: row.cardKey,
        credits: row.credits,
        creditStatus: row.creditStatus,
        accountId: row.id,
        accountName: row.name,
        status: row.cardDisabled ? 'disabled' : 'active',
        redeemStatus: row.redeemStatus,
        redeemedAt: row.redeemedAt,
        createdAt: row.createdAt,
        remark: row.remark,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      summary: result.summary,
    };
  }

  async updateCard(id: number, patch: { status?: string; remark?: string }) {
    const account = await this.getById(id, false);
    const data: Prisma.AccountUpdateInput = {};
    if (patch?.status !== undefined) {
      const status = String(patch.status);
      if (!['active', 'disabled'].includes(status)) bizError('BAD_INPUT', `不支持的卡密状态：${status}`);
      data.cardDisabled = status === 'disabled';
    }
    if (patch?.remark !== undefined) data.remark = String(patch.remark);
    const updated = await this.prisma.account.update({
      where: { id: account.id },
      data,
      include: { mailbox: { select: { email: true, clientId: true, refreshToken: true } } },
    });
    const row = this.toRow(updated);
    return {
      id: row.id,
      cardKey: row.cardKey,
      credits: row.credits,
      status: row.cardDisabled ? 'disabled' : 'active',
      redeemStatus: row.redeemStatus,
      redeemedAt: row.redeemedAt,
      remark: row.remark,
    };
  }

  async batchDisableCards(ids: number[]) {
    const list = (ids || []).map((id) => Number(id)).filter((id) => Number.isFinite(id));
    if (!list.length) bizError('BAD_INPUT', '请选择要停用的卡密');
    const result = await this.prisma.account.updateMany({
      where: { id: { in: list } },
      data: { cardDisabled: true },
    });
    return { updated: result.count };
  }

  /**
   * 批量复制卡密。
   *
   * 两条调用路径共用这里：
   *  - 勾选行复制：传 `ids`（按前端勾选顺序返回）
   *  - 按当前筛选复制全部：传 `filter`（跨分页，最多 `limit` 条，超出部分截断）
   *
   * 与单张复制（`copyCard`）一致，复制动作累加 `copyCount`。
   * 文本由服务端拼好（一行一个卡密），前端直接进剪贴板。
   */
  async copyCards(payload: { ids?: unknown; filter?: AccountFilter; limit?: unknown }) {
    const ids = toIntArray(payload?.ids);
    const limit = Math.min(COPY_KEYS_MAX, toPositiveInt(payload?.limit, COPY_KEYS_DEFAULT));
    const where: Prisma.AccountWhereInput = ids.length
      ? { id: { in: ids } }
      : this.buildWhere(payload?.filter || {});

    const [total, found] = await Promise.all([
      this.prisma.account.count({ where }),
      this.prisma.account.findMany({
        where,
        select: { id: true, cardKey: true },
        orderBy: { id: 'desc' },
        take: limit,
      }),
    ]);

    // 勾选复制时按勾选顺序输出，筛选复制时保持「新导入在前」
    const order = new Map(ids.map((id, index) => [id, index]));
    const ordered = ids.length
      ? [...found].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      : found;

    const keys = ordered.map((item) => item.cardKey).filter((key) => Boolean(key));

    if (ordered.length) {
      await this.prisma.account.updateMany({
        where: { id: { in: ordered.map((item) => item.id) } },
        data: { copyCount: { increment: 1 } },
      });
    }

    return {
      count: keys.length,
      total,
      truncated: total > keys.length,
      keys,
      text: keys.join('\n'),
    };
  }

  // -------------------------------------------------------------------------
  // 统计
  // -------------------------------------------------------------------------

  async overview() {
    const [summary, batches, trendRaw, tierStats] = await Promise.all([
      this.computeSummary({}),
      this.prisma.batch.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
      this.prisma.redeemLog.groupBy({
        by: ['createdAt'],
        where: { success: true, createdAt: { gte: new Date(Date.now() - 14 * 86400000) } },
        _count: { _all: true },
      }),
      this.tiers(),
    ]);

    const trendMap = new Map<string, number>();
    for (let offset = 13; offset >= 0; offset--) {
      const date = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
      trendMap.set(date, 0);
    }
    for (const row of trendRaw) {
      const date = row.createdAt.toISOString().slice(0, 10);
      if (trendMap.has(date)) trendMap.set(date, (trendMap.get(date) || 0) + row._count._all);
    }

    return {
      accounts: {
        total: summary.total,
        unredeemed: summary.unredeemed,
        redeemed: summary.redeemed,
        banned: summary.banned,
        invalid: summary.invalid,
        unknown: summary.unknown,
        pending: summary.pending,
      },
      cards: {
        total: summary.total,
        redeemed: summary.redeemed,
        unredeemed: summary.unredeemed,
      },
      batches: batches.map((batch) => ({
        batchId: batch.batchId,
        credits: batch.credits,
        count: batch.count,
        remark: batch.remark,
        source: batch.source,
        createdAt: batch.createdAt.toISOString(),
      })),
      redeemTrend: [...trendMap.entries()].map(([date, count]) => ({ date, count })),
      byCredits: summary.byCredits,
      tiers: tierStats.items,
      pending: tierStats.pending,
    };
  }
}

function timestampToken(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
