const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
const { Logger } = require('@nestjs/common');
const { JwtService } = require('@nestjs/jwt');
const { PrismaClient } = require('@prisma/client');
const { initializeSchema } = require('../dist/prisma/initialize-schema');
const { SCHEMA_STATEMENTS } = require('../dist/prisma/schema-statements');
const { RedeemService } = require('../dist/public/public.service');
const { AccountsService } = require('../dist/accounts/accounts.service');
const { ConvertService } = require('../dist/convert/convert.service');
const { MailboxService } = require('../dist/mailbox/mailbox.service');
const { MailAnalyzerService } = require('../dist/mailbox/mail-analyzer.service');
const { AuthService } = require('../dist/auth/auth.service');
const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard');
const { SeedService } = require('../dist/seed.service');
const { jwtSecret, initialAdminPassword } = require('../dist/auth/security-config');
const { DEFAULT_SETTINGS } = require('../dist/settings/settings.service');
const { clientAddress } = require('../dist/common/utils');

Logger.overrideLogger(false);
global.fetch = async () => { throw new Error('回归测试禁止外部网络请求'); };
const CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const MS_TOKEN = 'M'.repeat(64);

function postgresUrl() {
  const url = process.env.DATABASE_URL || '';
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error('DATABASE_URL 必须是 PostgreSQL，回归测试不再使用 SQLite');
  }
  return url;
}

function urlForSchema(base, schema) {
  const url = new URL(base);
  url.searchParams.set('schema', schema);
  return url.toString();
}

async function fixture(t, { legacy = false, limit = 1 } = {}) {
  const base = postgresUrl();
  const schema = `t_${randomBytes(4).toString('hex')}`;
  const admin = new PrismaClient({ datasources: { db: { url: base } } });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  await admin.$disconnect();
  const prisma = new PrismaClient({ datasources: { db: { url: urlForSchema(base, schema) } } });
  t.after(async () => {
    await prisma.$disconnect();
    const cleanup = new PrismaClient({ datasources: { db: { url: base } } });
    await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.$disconnect();
  });
  if (legacy) {
    for (const statement of SCHEMA_STATEMENTS) {
      await prisma.$executeRawUnsafe(statement
        .replace('    "sessionVersion" INTEGER NOT NULL DEFAULT 0,\n', '')
        .replace('    "redeemedByCard" TEXT,\n', ''));
    }
  } else {
    await initializeSchema(prisma);
  }
  const settings = { getAll: async () => ({ ...DEFAULT_SETTINGS, redeemLimitPerCard: limit }) };
  const mailbox = new MailboxService(new MailAnalyzerService());
  const convert = new ConvertService();
  return {
    prisma, mailbox,
    redeem: new RedeemService(prisma, convert, mailbox, settings),
    accounts: new AccountsService(prisma, convert, mailbox, settings),
  };
}

async function createAccount(prisma, index = 1, extra = {}) {
  const email = `account${index}@example.com`;
  return prisma.account.create({
    data: {
      name: email, email, credits: 40, cardKey: `CARD-AAAAA-BBBBB-${String(index).padStart(5, '2')}`,
      accessToken: 'synthetic-access-token', refreshToken: 'synthetic-openai-refresh', banStatus: 'normal',
      expiresAt: new Date(Date.now() + 3600000),
      mailbox: { create: { email, password: 'placeholder-password', clientId: CLIENT_ID, refreshToken: MS_TOKEN } },
      ...extra,
    },
    include: { mailbox: true },
  });
}

function pickupResult(email, overrides = {}) {
  return { key: email, email, ok: true, error: null, banned: false, banReason: null, banKeywords: [],
    credits: null, creditsBalance: null, latestCode: null, messages: [], fetchedAt: new Date().toISOString(), ...overrides };
}

test('旧库迁移保留账号与密码，回填历史主账号归属，重复执行幂等', async (t) => {
  const { prisma } = await fixture(t, { legacy: true });
  await prisma.$executeRawUnsafe(`INSERT INTO "AdminUser" ("username", "passwordHash", "updatedAt") VALUES ('legacy-admin', 'hash-kept', CURRENT_TIMESTAMP)`);
  await prisma.$executeRawUnsafe(`INSERT INTO "Account" ("name", "credits", "cardKey", "accessToken", "redeemStatus", "updatedAt") VALUES ('old', 40, 'CARD-OLD', 'token-kept', 'redeemed', CURRENT_TIMESTAMP)`);
  await initializeSchema(prisma);
  await initializeSchema(prisma);
  const admin = await prisma.adminUser.findUnique({ where: { username: 'legacy-admin' } });
  assert.equal(admin.passwordHash, 'hash-kept');
  assert.equal(admin.sessionVersion, 0);
  const account = await prisma.account.findUnique({ where: { cardKey: 'CARD-OLD' } });
  assert.equal(account.accessToken, 'token-kept');
  assert.equal(account.redeemedByCard, 'CARD-OLD');
  assert.equal(await prisma.schemaMigration.count(), 1);
});

test('仅邮箱解析、取件及导出均不能获取库存凭据', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  const resolved = await f.redeem.resolvePickup({ input: account.email });
  assert.equal(resolved.records[0].complete, false);
  assert.equal(resolved.records[0].fromCard, null);
  assert.equal(resolved.records[0].accountId, null);
  assert.equal(resolved.records[0].line, undefined);
  const fetched = await f.redeem.fetchPickup({ records: [{ key: account.email }] });
  assert.equal(fetched.results[0].ok, false);
  assert.equal(fetched.results[0].cardKey, null);
  await assert.rejects(f.redeem.exportPickup({ keys: [account.email], kind: 'line' }));
  await assert.rejects(f.redeem.exportPickup({ records: [{ key: account.email }], kind: 'line' }), /有效卡密/);
});

test('卡密可取件与导出，停用后所有公开路径拒绝继续读取', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  const resolved = await f.redeem.resolvePickup({ input: account.cardKey });
  assert.equal(resolved.records[0].complete, true);
  assert.equal(resolved.records[0].line, undefined);
  const record = { key: account.email, fromCard: account.cardKey };
  const exported = await f.redeem.exportPickup({ records: [record], kind: 'line' });
  assert(exported.content.includes(MS_TOKEN));
  f.mailbox.pickupOne = async (credential) => pickupResult(credential.email);
  assert.equal((await f.redeem.fetchPickup({ records: [record] })).results[0].ok, true);
  await f.prisma.account.update({ where: { id: account.id }, data: { cardDisabled: true } });
  assert.equal((await f.redeem.resolvePickup({ input: account.cardKey })).records.length, 0);
  await assert.rejects(f.redeem.exportPickup({ records: [record], kind: 'line' }));
});

test('自带凭据与库存隔离，伪造 key/fromCard 不能改写目标账号', async (t) => {
  const f = await fixture(t);
  const victim = await createAccount(f.prisma, 1, { banStatus: 'banned' });
  const line = `outside@example.com----placeholder----${CLIENT_ID}----${MS_TOKEN}`;
  f.mailbox.pickupOne = async (credential) => pickupResult(credential.email, { credits: 25000 });
  const response = await f.redeem.fetchPickup({ records: [{ key: victim.email, fromCard: victim.cardKey, line }] });
  assert.equal(response.results[0].email, 'outside@example.com');
  assert.equal(response.results[0].accountId, null);
  assert.equal(response.results[0].cardKey, null);
  const fresh = await f.prisma.account.findUnique({ where: { id: victim.id } });
  assert.equal(fresh.credits, 40);
  assert.equal(fresh.banStatus, 'banned');
  assert.equal(await f.prisma.pickupLog.count(), 0);
});

test('上传 JSON 自带凭据可以解析、继续取件和导出，无需存在于库存', async (t) => {
  const f = await fixture(t);
  const input = JSON.stringify({ type: 'codex', access_token: 'placeholder', email: 'external@example.com',
    notes: JSON.stringify({ mailbox: { email: 'external@example.com', client_id: CLIENT_ID, refresh_token: MS_TOKEN, password: 'placeholder' } }) });
  const resolved = await f.redeem.resolvePickup({ files: [{ content: input }] });
  assert.equal(resolved.records.length, 1);
  assert.equal(resolved.records[0].complete, true);
  assert(resolved.records[0].line.includes(MS_TOKEN));
  f.mailbox.pickupOne = async (credential) => pickupResult(credential.email);
  assert.equal((await f.redeem.fetchPickup({ records: resolved.records })).results[0].ok, true);
  assert((await f.redeem.exportPickup({ records: resolved.records, kind: 'line' })).content.includes(MS_TOKEN));
});

test('邮箱 TXT：JSON 导入落库后，后台导出和兑换均保留账密与 2FA', async (t) => {
  const f = await fixture(t);
  const password = '@Demo$pa*ss!';
  const secret = 'JBSWY3DPEHPK3PXP';
  const records = [1, 2].map((index) => {
    const email = `delivery${index}@example.com`;
    const notes = { mailbox: { email, password: 'mailbox-demo', client_id: CLIENT_ID, refresh_token: MS_TOKEN } };
    if (index === 1) {
      notes.gpt = { password };
      notes.two_factor = { secret };
    }
    return { type: 'codex', email, access_token: 'synthetic-access-token', notes: JSON.stringify(notes) };
  });
  const imported = await f.accounts.importAccounts({ content: JSON.stringify(records) });
  assert.equal(imported.imported, 2);
  assert.equal(imported.failed, 0);
  const rows = await f.prisma.account.findMany({ orderBy: { id: 'asc' }, include: { mailbox: true } });
  assert.deepEqual(JSON.parse(rows[0].rawJson), records[0]);
  const baseLines = rows.map((row) => `${row.email}----mailbox-demo----${CLIENT_ID}----${MS_TOKEN}`);
  const expectedLines = [`${baseLines[0]}----${password}----${secret}`, baseLines[1]];
  const expected = `${expectedLines.join('\n')}\n`;
  assert.equal((await f.accounts.exportAccounts({ format: 'email', ids: rows.map((row) => row.id) })).content, expected);

  await f.prisma.account.updateMany({ data: { credits: 40, banStatus: 'normal' } });
  const request = { cards: rows.map((row) => row.cardKey), format: 'email' };
  const delivered = await f.redeem.redeem(request);
  assert.equal(delivered.mergedContent, expected);
  for (const [index, result] of delivered.results.entries()) {
    assert.equal(result.ok, true);
    assert.equal(result.content, `${expectedLines[index]}\n`);
  }
  assert.equal((await f.redeem.redeem(request)).mergedContent, expected, '重复兑换保持同样的交付内容');
  const pickup = await f.redeem.exportPickup({
    records: [{ key: rows[0].email, fromCard: rows[0].cardKey }], kind: 'line',
  });
  assert.equal(pickup.content.trim(), baseLines[0], '邮箱取件的凭据导出仍只包含邮箱四段');
});

test('服务端限制每卡数量，多账号全部占用，重试不增发且附加卡不能重复领取', async (t) => {
  const f = await fixture(t, { limit: 2 });
  const [a, b, c] = await Promise.all([1, 2, 3].map((index) => createAccount(f.prisma, index)));
  const first = await f.redeem.redeem({ cards: [a.cardKey], format: 'email', limit: 20 });
  assert.equal(first.results[0].accountCount, 2);
  const owned = await f.prisma.account.findMany({ where: { redeemedByCard: a.cardKey } });
  assert.equal(owned.length, 2);
  assert(owned.every((row) => row.redeemStatus === 'redeemed'));
  const retry = await f.redeem.redeem({ cards: [a.cardKey], format: 'email', limit: 1 });
  assert.equal(retry.results[0].content, first.results[0].content);
  assert.equal(retry.results[0].firstRedeem, false);
  const extra = owned.find((row) => row.id !== a.id);
  const duplicate = await f.redeem.redeem({ cards: [extra.cardKey], format: 'email' });
  assert.equal(duplicate.results[0].code, 'CARD_ALLOCATED');
  assert.equal(await f.prisma.account.count({ where: { redeemStatus: 'unredeemed' } }), 1);
  assert.equal((await f.redeem.resolvePickup({ input: a.cardKey })).records.length, 2);
  assert.equal((await f.redeem.resolvePickup({ input: extra.cardKey })).records.length, 0);
});

test('并发重复兑换返回同一集合，另一张卡不会重复占用同一账号', async (t) => {
  const f = await fixture(t, { limit: 2 });
  const accounts = [];
  for (let index = 1; index <= 4; index++) accounts.push(await createAccount(f.prisma, index));
  const [first, retry, other] = await Promise.all([
    f.redeem.redeem({ cards: [accounts[0].cardKey], format: 'email', limit: 2 }),
    f.redeem.redeem({ cards: [accounts[0].cardKey], format: 'email', limit: 2 }),
    f.redeem.redeem({ cards: [accounts[3].cardKey], format: 'email', limit: 2 }),
  ]);
  assert.equal(first.results[0].content, retry.results[0].content);
  assert.equal(other.results[0].ok, true);
  const firstIds = new Set(first.results[0].accounts.map((row) => row.id));
  assert(other.results[0].accounts.every((row) => !firstIds.has(row.id)));
});

test('转换异常回滚全部库存占用', async (t) => {
  const f = await fixture(t, { limit: 2 });
  const first = await createAccount(f.prisma);
  await createAccount(f.prisma, 2);
  f.redeem.convert.buildDeliverContent = () => { throw new Error('synthetic conversion failure'); };
  const result = await f.redeem.redeem({ cards: [first.cardKey], format: 'email', limit: 2 });
  assert.equal(result.results[0].code, 'INTERNAL');
  assert.equal(result.results[0].content, null);
  assert.equal(await f.prisma.account.count({ where: { redeemStatus: 'unredeemed', redeemedByCard: null } }), 2);
});

test('失效账号拒绝兑换，已交付账号禁止重置和重新生成卡密', async (t) => {
  const f = await fixture(t);
  const invalid = await createAccount(f.prisma, 1, { banStatus: 'invalid' });
  assert.equal((await f.redeem.redeem({ cards: [invalid.cardKey] })).results[0].code, 'NO_STOCK');
  const valid = await createAccount(f.prisma, 2);
  await f.redeem.redeem({ cards: [valid.cardKey] });
  await assert.rejects(f.accounts.update(valid.id, { redeemStatus: 'unredeemed' }), /重复出售/);
  await assert.rejects(f.accounts.generateCards({ ids: [valid.id], regenerate: true }), /不能重新生成/);
});

test('仅刷新过期 OpenAI token，轮换不改变兑换状态，也不覆盖取件封禁结果', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma, 1, { expiresAt: new Date(0) });
  f.mailbox.pickupOne = async () => pickupResult(account.email, { banned: true, banReason: 'synthetic ban', banKeywords: ['account deactivated'] });
  f.mailbox.refreshOpenAiToken = async () => ({ ok: true, accessToken: 'new-access', refreshToken: 'new-openai', expiresAt: new Date(Date.now() + 3600000) });
  const response = await f.accounts.refreshStatus({ ids: [account.id], targets: ['ban', 'redeem'] });
  const fresh = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(fresh.refreshToken, 'new-openai');
  assert.equal(fresh.banStatus, 'banned');
  assert.equal(fresh.redeemStatus, 'unredeemed');
  assert.equal(response.items[0].banStatus, 'banned');
  f.mailbox.refreshOpenAiToken = async () => { throw new Error('有效 token 不应刷新'); };
  assert.equal((await f.accounts.refreshStatus({ ids: [account.id], targets: ['redeem'] })).redeem.failed, 0);
});

test('微软 refresh token 不会被送到 OpenAI', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma, 1, { refreshToken: null, expiresAt: new Date(1000) });
  f.mailbox.refreshOpenAiToken = async () => { throw new Error('不应调用'); };
  const response = await f.accounts.refreshStatus({ ids: [account.id], targets: ['redeem'] });
  assert.match(response.items[0].error, /缺少 OpenAI/);
  assert.equal((await f.prisma.mailCredential.findUnique({ where: { accountId: account.id } })).refreshToken, MS_TOKEN);
});

test('刷新汇总与最终状态一致：邮箱正常但 OpenAI 凭据失效', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma, 1, { expiresAt: new Date(0) });
  f.mailbox.pickupOne = async () => pickupResult(account.email);
  f.mailbox.refreshOpenAiToken = async () => ({ ok: false, invalidCredential: true, error: 'invalid_grant' });
  const response = await f.accounts.refreshStatus({ ids: [account.id], targets: ['ban', 'redeem'] });
  assert.equal(response.items[0].banStatus, 'invalid');
  assert.deepEqual(response.ban, { banned: 0, normal: 0, invalid: 1, failed: 0 });
  assert.equal(response.redeem.failed, 1);
});

test('修改密码撤销所有旧 JWT，旧格式 JWT 也不能绕过会话版本检查', async (t) => {
  const { prisma } = await fixture(t);
  const jwt = new JwtService({ secret: 'synthetic-test-secret-at-least-32-characters', signOptions: { expiresIn: '1h' } });
  const auth = new AuthService(prisma, jwt);
  const guard = new JwtAuthGuard(jwt, prisma);
  const admin = await prisma.adminUser.create({ data: { username: 'admin', passwordHash: await bcrypt.hash('old-test-password', 4) } });
  const context = (token) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }) }) });
  const old = await auth.login('admin', 'old-test-password');
  assert.equal(await guard.canActivate(context(old.token)), true);
  await auth.changePassword(admin.id, 'old-test-password', 'new-test-password');
  await assert.rejects(guard.canActivate(context(old.token)));
  await assert.rejects(guard.canActivate(context(jwt.sign({ sub: admin.id, role: 'admin' }))));
  const current = await auth.login('admin', 'new-test-password');
  assert.equal(await guard.canActivate(context(current.token)), true);
});

test('生产环境拒绝默认签名密钥和初始密码', () => {
  const previous = { ...process.env };
  try {
    process.env.NODE_ENV = 'production';
    for (const secret of ['', 'cardline-dev-secret-change-me', 'cardline-please-change-this-secret', 'change-me-in-production']) {
      process.env.JWT_SECRET = secret;
      assert.throws(jwtSecret);
    }
    process.env.ADMIN_PASSWORD = 'admin123';
    assert.throws(initialAdminPassword);
    process.env.JWT_SECRET = 'synthetic-independent-secret-with-32-characters';
    process.env.ADMIN_PASSWORD = 'synthetic-long-password';
    assert.equal(jwtSecret(), process.env.JWT_SECRET);
    assert.equal(initialAdminPassword(), process.env.ADMIN_PASSWORD);
  } finally {
    for (const key of ['NODE_ENV', 'JWT_SECRET', 'ADMIN_PASSWORD']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

function reclaimService(prisma, mailbox, refresh) {
  const settings = { getAll: async () => ({ ...DEFAULT_SETTINGS, defaultFormat: 'sub2api' }) };
  return new RedeemService(prisma, new ConvertService(), mailbox, settings, { refresh });
}

async function markRedeemed(prisma, account) {
  await prisma.account.update({
    where: { id: account.id },
    data: { redeemStatus: 'redeemed', redeemedByCard: account.cardKey, redeemedAt: new Date('2026-01-01T00:00:00Z') },
  });
}

test('未兑换、缺少刷新凭据或刷新失败时不改库存', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    return { ok: true, credentials: { accessToken: 'should-not-write', refreshToken: 'should-not-write' } };
  };
  const service = reclaimService(f.prisma, f.mailbox, refresh);
  const fresh = await service.reclaim({ cards: [account.cardKey], format: 'cockpit' });
  assert.equal(fresh.results[0].code, 'CARD_NOT_REDEEMED');
  assert.equal(calls, 0);

  await markRedeemed(f.prisma, account);
  await f.prisma.account.update({ where: { id: account.id }, data: { refreshToken: null } });
  const missing = await service.reclaim({ cards: [account.cardKey], format: 'codex' });
  assert.equal(missing.results[0].code, 'REFRESH_MISSING');
  assert.equal(calls, 0);

  await f.prisma.account.update({ where: { id: account.id }, data: { refreshToken: 'synthetic-openai-refresh' } });
  const failing = reclaimService(f.prisma, f.mailbox, async () => {
    calls += 1;
    return { ok: false, error: 'upstream' };
  });
  const failed = await failing.reclaim({ cards: [account.cardKey], format: 'codex' });
  assert.equal(failed.results[0].code, 'REFRESH_FAILED');
  const unchanged = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(unchanged.accessToken, 'synthetic-access-token');
  assert.equal(unchanged.refreshToken, 'synthetic-openai-refresh');
});

test('找回成功只刷新一次，写库失败也不会再次请求旧凭据', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  let calls = 0;
  const refresh = async (token) => {
    calls += 1;
    assert.equal(token, calls === 1 ? 'synthetic-openai-refresh' : 'refreshed-token');
    const rotated = calls > 1;
    return {
      ok: true,
      credentials: {
        accessToken: rotated ? 'brand-new-access' : 'refreshed-access',
        refreshToken: rotated ? 'brand-new-refresh' : 'refreshed-token',
        idToken: rotated ? 'brand-new-id' : 'refreshed-id',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    };
  };
  const service = reclaimService(f.prisma, f.mailbox, refresh);
  const result = await service.reclaim({ cards: [account.cardKey], format: 'codex' });
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].firstRedeem, false);
  assert.equal(result.results[0].message, '凭据已刷新');
  assert.equal(result.mergedContent, null);
  assert.equal(calls, 1);
  const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(saved.accessToken, 'refreshed-access');
  assert.equal(saved.refreshToken, 'refreshed-token');
  assert.equal(saved.idToken, 'refreshed-id');
  const log = await f.prisma.redeemLog.findFirst({ where: { cardKey: account.cardKey } });
  assert.equal(log.format, 'reclaim:codex');
  assert.equal(log.message, 'OK');
  assert.equal(JSON.stringify(log).includes('refreshed-access'), false);
  await service.releaseDeliveredHolds([account.cardKey]);

  const original = f.prisma.$transaction.bind(f.prisma);
  f.prisma.$transaction = async (fn, options) => {
    if (typeof fn !== 'function') return original(fn, options);
    return original(async (tx) => {
      tx.account.updateMany = async () => {
        throw new Error('database write failed');
      };
      return fn(tx);
    }, options);
  };
  const callsBeforeWriteFailure = calls;
  const failedWrite = await service.reclaim({ cards: [account.cardKey], format: 'codex' });
  assert.equal(calls - callsBeforeWriteFailure, 1);
  assert.equal(failedWrite.results[0].code, 'PERSIST_FAILED');
  assert.equal(failedWrite.results[0].ok, false);
  assert.match(failedWrite.results[0].content, /brand-new-access/);
  assert.equal(JSON.stringify(await f.prisma.redeemLog.findFirst({
    where: { cardKey: account.cardKey, message: 'PERSIST_FAILED' },
    orderBy: { id: 'desc' },
  })).includes('brand-new-access'), false);
  f.prisma.$transaction = original;
  const still = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(still.refreshToken, 'refreshed-token');
});

test('一张卡后面的账号刷新失败时，前面已经换到的凭据仍然落库', async (t) => {
  const f = await fixture(t);
  const primary = await createAccount(f.prisma, 1);
  const extra = await createAccount(f.prisma, 2);
  await markRedeemed(f.prisma, primary);
  await f.prisma.account.update({
    where: { id: extra.id },
    data: { redeemStatus: 'redeemed', redeemedByCard: primary.cardKey, redeemedAt: new Date('2026-01-01T00:00:00Z') },
  });
  const calls = [];
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    calls.push(token);
    if (token === 'synthetic-openai-refresh' && calls.length > 1) return { ok: false, error: 'second failed' };
    return { ok: true, credentials: { accessToken: 'new-access-1', refreshToken: 'new-refresh-1' } };
  });
  const result = await service.reclaim({ cards: [primary.cardKey], format: 'email' });
  assert.equal(result.results[0].code, 'REFRESH_FAILED');
  assert.match(result.results[0].message, /保存/);
  assert.match(result.results[0].content, /new-access-1/);
  assert.match(result.results[0].content, /new-refresh-1/);
  assert.match(result.mergedContent, /new-refresh-1/);
  assert.deepEqual(calls, ['synthetic-openai-refresh', 'synthetic-openai-refresh']);
  const savedPrimary = await f.prisma.account.findUnique({ where: { id: primary.id } });
  const savedExtra = await f.prisma.account.findUnique({ where: { id: extra.id } });
  assert.equal(savedPrimary.refreshToken, 'new-refresh-1');
  assert.equal(savedPrimary.accessToken, 'new-access-1');
  assert.equal(savedExtra.refreshToken, 'synthetic-openai-refresh');
});

test('写库失败只影响当前卡，同一次找回里其他卡仍返回', async (t) => {
  const f = await fixture(t);
  const first = await createAccount(f.prisma, 1);
  const second = await createAccount(f.prisma, 2);
  await markRedeemed(f.prisma, first);
  await markRedeemed(f.prisma, second);
  const original = f.prisma.$transaction.bind(f.prisma);
  let transactions = 0;
  f.prisma.$transaction = async (fn, options) => {
    transactions += 1;
    if (transactions >= 2) throw new Error('database write failed');
    return original(fn, options);
  };
  const service = reclaimService(f.prisma, f.mailbox, async () => ({
    ok: true,
    credentials: { accessToken: 'batch-access', refreshToken: 'batch-refresh' },
  }));
  const result = await service.reclaim({ cards: [first.cardKey, second.cardKey], format: 'codex' });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].code, 'PERSIST_FAILED');
  assert.match(result.results[1].content, /batch-access/);
  assert.match(result.results[1].content, /batch-refresh/);
  const savedFirst = await f.prisma.account.findUnique({ where: { id: first.id } });
  const savedSecond = await f.prisma.account.findUnique({ where: { id: second.id } });
  assert.equal(savedFirst.refreshToken, 'batch-refresh');
  assert.equal(savedSecond.refreshToken, 'synthetic-openai-refresh');
});

test('邮箱格式写库失败时，结果文件仍包含新的 OpenAI 凭据', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  const original = f.prisma.$transaction.bind(f.prisma);
  f.prisma.$transaction = async (fn, options) => {
    if (typeof fn !== 'function') return original(fn, options);
    return original(async (tx) => {
      tx.account.updateMany = async () => {
        throw new Error('database write failed');
      };
      return fn(tx);
    }, options);
  };
  const service = reclaimService(f.prisma, f.mailbox, async () => ({
    ok: true,
    credentials: { accessToken: 'brand-new-access', refreshToken: 'brand-new-refresh' },
  }));
  const failed = await service.reclaim({ cards: [account.cardKey], format: 'email' });
  assert.equal(failed.results[0].code, 'PERSIST_FAILED');
  assert.match(failed.results[0].content, /brand-new-access/);
  assert.match(failed.results[0].content, /brand-new-refresh/);
  assert.match(failed.mergedContent, /brand-new-access/);
  assert.match(failed.mergedContent, /brand-new-refresh/);
  assert.equal(JSON.stringify(await f.prisma.redeemLog.findFirst({
    where: { cardKey: account.cardKey },
    orderBy: { id: 'desc' },
  })).includes('brand-new-access'), false);
  const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(saved.refreshToken, 'synthetic-openai-refresh');
});

test('刷新进行时不占着账号行锁，返回后仍写回新凭据', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  const original = f.prisma.$transaction.bind(f.prisma);
  let inTransaction = false;
  let refreshInsideTransaction = false;
  f.prisma.$transaction = async (fn, options) => {
    if (typeof fn !== 'function') return original(fn, options);
    inTransaction = true;
    try {
      return await original(fn, options);
    } finally {
      inTransaction = false;
    }
  };
  const service = reclaimService(f.prisma, f.mailbox, async () => {
    refreshInsideTransaction = inTransaction;
    return { ok: true, credentials: { accessToken: 'held-access', refreshToken: 'held-refresh' } };
  });
  const result = await service.reclaim({ cards: [account.cardKey], format: 'codex' });
  assert.equal(result.results[0].ok, true);
  assert.equal(refreshInsideTransaction, false);
  const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(saved.refreshToken, 'held-refresh');
  assert.equal(saved.accessToken, 'held-access');
});

test('写库失败重试期间，另一次找回不会用同一个旧凭据再刷新', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  const original = f.prisma.$transaction.bind(f.prisma);
  let transactions = 0;
  let releaseWrite = () => {};
  const writeGate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  f.prisma.$transaction = async (fn, options) => {
    transactions += 1;
    if (transactions === 1 && typeof fn === 'function') {
      return original(async (tx) => {
        tx.account.updateMany = async () => {
          throw new Error('database write failed');
        };
        return fn(tx);
      }, options);
    }
    if (transactions === 2) await writeGate;
    return original(fn, options);
  };
  const seen = [];
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    seen.push(token);
    return {
      ok: true,
      credentials: { accessToken: `access-${seen.length}`, refreshToken: `refresh-${seen.length}` },
    };
  });
  const first = service.reclaim({ cards: [account.cardKey], format: 'codex' });
  try {
    const started = Date.now();
    while (transactions < 1 && Date.now() - started < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const second = service.reclaim({ cards: [account.cardKey], format: 'codex' });
    const overlap = Date.now();
    while (seen.length < 2 && Date.now() - overlap < 400) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(seen.length, 1);
    releaseWrite();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.results[0].ok, true);
    assert.equal(secondResult.results[0].ok, true);
    assert.deepEqual(seen, ['synthetic-openai-refresh']);
    assert.match(secondResult.results[0].content, /access-1/);
    const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
    assert.equal(saved.refreshToken, 'refresh-1');
    assert.equal(saved.refreshHeld, true);
    return second;
  } finally {
    releaseWrite();
    await Promise.allSettled([first]);
  }
});

test('批量兑换某一张失败时，已经兑换的卡仍返回', async (t) => {
  const f = await fixture(t);
  const first = await createAccount(f.prisma, 1);
  const second = await createAccount(f.prisma, 2);
  const original = f.prisma.$transaction.bind(f.prisma);
  let transactions = 0;
  f.prisma.$transaction = async (fn, options) => {
    transactions += 1;
    if (transactions >= 2) throw new Error('database write failed');
    return original(fn, options);
  };
  const result = await f.redeem.redeem({ cards: [first.cardKey, second.cardKey], format: 'sub2api' });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].ok, true);
  assert.match(result.results[0].content, /synthetic-access-token/);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].code, 'INTERNAL');
  const savedFirst = await f.prisma.account.findUnique({ where: { id: first.id } });
  const savedSecond = await f.prisma.account.findUnique({ where: { id: second.id } });
  assert.equal(savedFirst.redeemStatus, 'redeemed');
  assert.equal(savedSecond.redeemStatus, 'unredeemed');
});

test('并发找回等待前一次写回，不会用同一个旧凭据刷新两次', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const seen = [];
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    seen.push(token);
    if (seen.length === 1) await gate;
    const refreshToken = `next-${seen.length}`;
    return { ok: true, credentials: { accessToken: `access-${refreshToken}`, refreshToken } };
  });
  const first = service.reclaim({ cards: [account.cardKey], format: 'codex' });
  const secondPromise = (async () => {
    const started = Date.now();
    while (seen.length < 1 && Date.now() - started < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const second = service.reclaim({ cards: [account.cardKey], format: 'codex' });
    const overlap = Date.now();
    while (seen.length < 2 && Date.now() - overlap < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(seen.length, 1);
    release();
    return second;
  })();
  try {
    const second = await secondPromise;
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.results[0].ok, true);
    assert.equal(secondResult.results[0].ok, true);
    assert.deepEqual(seen, ['synthetic-openai-refresh']);
    assert.match(secondResult.results[0].content, /access-next-1/);
    const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
    assert.equal(saved.refreshToken, 'next-1');
    assert.equal(saved.refreshHeld, true);
  } finally {
    release();
    await Promise.allSettled([first, secondPromise.then((second) => second)]);
  }
});

test('只标记已兑换但没有归属时，找回会补归属并刷新', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await f.accounts.update(account.id, { redeemStatus: 'redeemed' });
  const marked = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(marked.redeemStatus, 'redeemed');
  assert.equal(marked.redeemedByCard, account.cardKey);

  const legacy = await createAccount(f.prisma, 2);
  await f.prisma.account.update({
    where: { id: legacy.id },
    data: { redeemStatus: 'redeemed', redeemedByCard: null, redeemedAt: new Date('2026-01-01T00:00:00Z') },
  });
  const service = reclaimService(f.prisma, f.mailbox, async () => ({
    ok: true,
    credentials: { accessToken: 'legacy-access', refreshToken: 'legacy-refresh' },
  }));
  const result = await service.reclaim({ cards: [legacy.cardKey], format: 'codex' });
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].code, 'OK');
  const saved = await f.prisma.account.findUnique({ where: { id: legacy.id } });
  assert.equal(saved.redeemedByCard, legacy.cardKey);
  assert.equal(saved.refreshToken, 'legacy-refresh');
});

function jwtWithExp(exp) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

test('刷新没有带回过期时间时不沿用旧值，idToken 仍保留', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  const previousExpiry = new Date('2020-01-01T00:00:00Z');
  await f.prisma.account.update({
    where: { id: account.id },
    data: { idToken: 'stale-id-token', expiresAt: previousExpiry },
  });
  const service = reclaimService(f.prisma, f.mailbox, async () => ({
    ok: true,
    credentials: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' },
  }));
  const result = await service.reclaim({ cards: [account.cardKey], format: 'codex' });
  assert.equal(result.results[0].ok, true);
  const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(saved.accessToken, 'fresh-access');
  assert.equal(saved.refreshToken, 'fresh-refresh');
  assert.equal(saved.idToken, 'stale-id-token');
  assert.equal(saved.expiresAt, null);

  const exp = Math.trunc(Date.now() / 1000) + 7200;
  const jwtAccount = await createAccount(f.prisma, 2);
  await markRedeemed(f.prisma, jwtAccount);
  await f.prisma.account.update({
    where: { id: jwtAccount.id },
    data: { expiresAt: previousExpiry },
  });
  const jwtService = reclaimService(f.prisma, f.mailbox, async () => ({
    ok: true,
    credentials: { accessToken: jwtWithExp(exp), refreshToken: 'jwt-refresh' },
  }));
  const jwtResult = await jwtService.reclaim({ cards: [jwtAccount.cardKey], format: 'codex' });
  assert.equal(jwtResult.results[0].ok, true);
  const jwtSaved = await f.prisma.account.findUnique({ where: { id: jwtAccount.id } });
  assert.equal(jwtSaved.expiresAt.toISOString(), new Date(exp * 1000).toISOString());
});

test('写库失败后再次找回和重导出都使用暂存凭据，不再刷新旧凭据', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  const original = f.prisma.$transaction.bind(f.prisma);
  f.prisma.$transaction = async (fn, options) => {
    if (typeof fn !== 'function') return original(fn, options);
    return original(async (tx) => {
      tx.account.updateMany = async () => {
        throw new Error('database write failed');
      };
      return fn(tx);
    }, options);
  };
  const seen = [];
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    seen.push(token);
    return { ok: true, credentials: { accessToken: 'staged-access', refreshToken: 'staged-refresh', idToken: 'staged-id' } };
  });
  const failed = await service.reclaim({ cards: [account.cardKey], format: 'codex' });
  assert.equal(failed.results[0].code, 'PERSIST_FAILED');
  assert.match(failed.results[0].content, /staged-refresh/);
  const stored = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(stored.refreshToken, 'synthetic-openai-refresh');
  assert.match(stored.stagedCredential, /staged-refresh/);
  const again = await service.reclaim({ cards: [account.cardKey], format: 'codex' });
  assert.equal(again.results[0].code, 'PERSIST_FAILED');
  assert.match(again.results[0].content, /staged-refresh/);
  assert.deepEqual(seen, ['synthetic-openai-refresh']);
  f.prisma.$transaction = original;
  const exported = await service.redeem({ cards: [account.cardKey], format: 'codex' });
  assert.equal(exported.results[0].ok, true);
  assert.match(exported.results[0].content, /staged-refresh/);
  assert.equal(exported.results[0].content.includes('synthetic-openai-refresh'), false);
  const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(saved.refreshToken, 'staged-refresh');
  assert.equal(saved.stagedCredential, null);
  assert.deepEqual(seen, ['synthetic-openai-refresh']);
});

test('部分刷新失败后再次找回，不轮换已经落库的凭据', async (t) => {
  const f = await fixture(t);
  const primary = await createAccount(f.prisma, 1);
  const extra = await createAccount(f.prisma, 2);
  await markRedeemed(f.prisma, primary);
  await f.prisma.account.update({
    where: { id: extra.id },
    data: { redeemStatus: 'redeemed', redeemedByCard: primary.cardKey, redeemedAt: new Date('2026-01-01T00:00:00Z') },
  });
  const calls = [];
  const service = reclaimService(f.prisma, f.mailbox, async () => {
    calls.push('refresh');
    if (calls.length === 2) return { ok: false, error: 'second failed' };
    return { ok: true, credentials: { accessToken: `access-${calls.length}`, refreshToken: `refresh-${calls.length}` } };
  });
  const first = await service.reclaim({ cards: [primary.cardKey], format: 'codex' });
  assert.equal(first.results[0].code, 'REFRESH_FAILED');
  assert.match(first.results[0].content, /refresh-1/);
  const second = await service.reclaim({ cards: [primary.cardKey], format: 'codex' });
  assert.equal(second.results[0].ok, true);
  assert.equal(second.results[0].content, null);
  assert.equal(second.results[0].files.length, 2);
  const secondBody = second.results[0].files.map((file) => file.content).join('\n');
  assert.match(secondBody, /refresh-1/);
  for (const file of second.results[0].files) assert.equal(Array.isArray(JSON.parse(file.content)), false);
  assert.equal(calls.length, 3);
  const savedPrimary = await f.prisma.account.findUnique({ where: { id: primary.id } });
  const savedExtra = await f.prisma.account.findUnique({ where: { id: extra.id } });
  assert.equal(savedPrimary.refreshToken, 'refresh-1');
  assert.equal(savedExtra.refreshToken, 'refresh-3');
});

test('邮箱格式找回成功后始终是四段或六段，不再附上 OpenAI JSON', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  const service = reclaimService(f.prisma, f.mailbox, async () => ({
    ok: true,
    credentials: { accessToken: 'email-new-access', refreshToken: 'email-new-refresh' },
  }));
  const result = await service.reclaim({ cards: [account.cardKey], format: 'email' });
  assert.equal(result.results[0].code, 'OK');
  assert.match(result.results[0].content, new RegExp(account.email));
  assert.equal(result.results[0].content.includes('email-new-access'), false);
  assert.equal(result.results[0].content.includes('email-new-refresh'), false);
  assert.equal(result.mergedContent.includes('email-new-refresh'), false);
  const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(saved.refreshToken, 'email-new-refresh');
  const again = await f.redeem.redeem({ cards: [account.cardKey], format: 'email' });
  assert.equal(again.results[0].ok, true);
  assert.equal(again.results[0].content.includes('email-new-access'), false);
  assert.equal(again.results[0].content.includes('email-new-refresh'), false);
  assert.match(again.results[0].content, new RegExp(account.email));
});

test('后台刷新写不进去时不算成功，有暂存时不再用旧凭据刷新', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma, 1, { expiresAt: new Date(0) });
  await f.prisma.account.update({
    where: { id: account.id },
    data: {
      stagedCredential: JSON.stringify({
        accessToken: 'staged-access',
        refreshToken: 'staged-refresh',
        idToken: 'staged-id',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        previousRefreshToken: 'synthetic-openai-refresh',
      }),
    },
  });
  f.mailbox.refreshOpenAiToken = async () => {
    throw new Error('不应再用旧凭据刷新');
  };
  const applied = await f.accounts.refreshStatus({ ids: [account.id], targets: ['redeem'] });
  assert.equal(applied.redeem.failed, 0);
  const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(saved.refreshToken, 'staged-refresh');
  assert.equal(saved.stagedCredential, null);

  await f.prisma.account.update({
    where: { id: account.id },
    data: { expiresAt: new Date(0), refreshToken: 'current-refresh', accessToken: 'current-access' },
  });
  const originalUpdate = f.prisma.account.updateMany.bind(f.prisma.account);
  f.prisma.account.updateMany = async (args) => {
    if (args?.data?.accessToken === 'admin-access') return { count: 0 };
    return originalUpdate(args);
  };
  f.mailbox.refreshOpenAiToken = async (token) => {
    assert.equal(token, 'current-refresh');
    return { ok: true, accessToken: 'admin-access', refreshToken: 'admin-refresh', expiresAt: new Date(Date.now() + 3600000) };
  };
  const missed = await f.accounts.refreshStatus({ ids: [account.id], targets: ['redeem'] });
  assert.equal(missed.redeem.failed, 1);
  assert.match(missed.items[0].error, /暂存/);
  const still = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(still.refreshToken, 'current-refresh');
  assert.match(still.stagedCredential, /admin-refresh/);
  f.prisma.account.updateMany = originalUpdate;
  f.mailbox.refreshOpenAiToken = async () => {
    throw new Error('暂存凭据不应再次刷新');
  };
  const committed = await f.accounts.refreshStatus({ ids: [account.id], targets: ['redeem'] });
  assert.equal(committed.redeem.failed, 0);
  const finalAccount = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(finalAccount.refreshToken, 'admin-refresh');
  assert.equal(finalAccount.stagedCredential, null);
});

test('部分找回后兑换重导出不会让下一轮找回只轮换刚交付的凭据', async (t) => {
  const f = await fixture(t);
  const primary = await createAccount(f.prisma, 1);
  const extra = await createAccount(f.prisma, 2);
  await markRedeemed(f.prisma, primary);
  await f.prisma.account.update({
    where: { id: extra.id },
    data: {
      redeemStatus: 'redeemed',
      redeemedByCard: primary.cardKey,
      redeemedAt: new Date('2026-01-01T00:00:00Z'),
      accessToken: 'old-extra-access',
      refreshToken: 'old-extra-refresh',
      stagedCredential: JSON.stringify({
        accessToken: 'staged-extra-access',
        refreshToken: 'staged-extra-refresh',
        idToken: 'staged-extra-id',
        expiresAt: null,
        previousRefreshToken: 'old-extra-refresh',
      }),
    },
  });
  await f.prisma.account.update({
    where: { id: primary.id },
    data: { refreshHeld: true, accessToken: 'live-access-1', refreshToken: 'live-refresh-1' },
  });
  const calls = [];
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    calls.push(token);
    return { ok: true, credentials: { accessToken: `access-${token}`, refreshToken: `rotated-${token}` } };
  });
  const exported = await service.redeem({ cards: [primary.cardKey], format: 'sub2api' });
  assert.equal(exported.results[0].ok, true);
  assert.match(exported.results[0].content, /staged-extra-refresh/);
  assert.equal(exported.results[0].content.includes('old-extra-refresh'), false);
  const savedExtra = await f.prisma.account.findUnique({ where: { id: extra.id } });
  const savedPrimary = await f.prisma.account.findUnique({ where: { id: primary.id } });
  assert.equal(savedExtra.refreshToken, 'staged-extra-refresh');
  assert.equal(savedExtra.stagedCredential, null);
  assert.equal(savedExtra.refreshHeld, true);
  assert.equal(savedPrimary.refreshHeld, true);
  const again = await service.reclaim({ cards: [primary.cardKey], format: 'sub2api' });
  assert.equal(again.results[0].ok, true);
  assert.deepEqual(calls, []);
  assert.match(again.results[0].content, /staged-extra-refresh/);
  assert.match(again.results[0].content, /live-refresh-1/);
  const finalExtra = await f.prisma.account.findUnique({ where: { id: extra.id } });
  const finalPrimary = await f.prisma.account.findUnique({ where: { id: primary.id } });
  assert.equal(finalExtra.refreshToken, 'staged-extra-refresh');
  assert.equal(finalPrimary.refreshToken, 'live-refresh-1');
});

test('后台提交暂存后，下一轮找回不会只轮换刚写入的凭据', async (t) => {
  const f = await fixture(t);
  const primary = await createAccount(f.prisma, 1);
  const extra = await createAccount(f.prisma, 2);
  await markRedeemed(f.prisma, primary);
  await f.prisma.account.update({
    where: { id: primary.id },
    data: { refreshHeld: true, accessToken: 'live-access-1', refreshToken: 'live-refresh-1' },
  });
  await f.prisma.account.update({
    where: { id: extra.id },
    data: {
      redeemStatus: 'redeemed',
      redeemedByCard: primary.cardKey,
      redeemedAt: new Date('2026-01-01T00:00:00Z'),
      accessToken: 'old-extra-access',
      refreshToken: 'old-extra-refresh',
      expiresAt: new Date(Date.now() + 3600000),
      stagedCredential: JSON.stringify({
        accessToken: 'admin-staged-access',
        refreshToken: 'admin-staged-refresh',
        idToken: 'admin-staged-id',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        previousRefreshToken: 'old-extra-refresh',
      }),
    },
  });
  f.mailbox.refreshOpenAiToken = async () => {
    throw new Error('不应再用旧凭据刷新');
  };
  const applied = await f.accounts.refreshStatus({ ids: [extra.id], targets: ['redeem'] });
  assert.equal(applied.redeem.failed, 0);
  const savedExtra = await f.prisma.account.findUnique({ where: { id: extra.id } });
  assert.equal(savedExtra.refreshToken, 'admin-staged-refresh');
  assert.equal(savedExtra.refreshHeld, true);
  const calls = [];
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    calls.push(token);
    return { ok: true, credentials: { accessToken: `access-${token}`, refreshToken: `rotated-${token}` } };
  });
  const again = await service.reclaim({ cards: [primary.cardKey], format: 'codex' });
  assert.equal(again.results[0].ok, true);
  assert.deepEqual(calls, []);
  const finalExtra = await f.prisma.account.findUnique({ where: { id: extra.id } });
  assert.equal(finalExtra.refreshToken, 'admin-staged-refresh');
});

test('邮箱格式兑换重导出只保留邮箱行，新凭据写入数据库', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  await f.prisma.account.update({
    where: { id: account.id },
    data: {
      stagedCredential: JSON.stringify({
        accessToken: 'mail-new-access',
        refreshToken: 'mail-new-refresh',
        idToken: 'mail-new-id',
        expiresAt: null,
        previousRefreshToken: 'synthetic-openai-refresh',
      }),
    },
  });
  const service = reclaimService(f.prisma, f.mailbox, async () => {
    throw new Error('不应再刷新');
  });
  const exported = await service.redeem({ cards: [account.cardKey], format: 'email' });
  assert.equal(exported.results[0].ok, true);
  assert.equal(exported.results[0].content.includes('mail-new-refresh'), false);
  assert.equal(exported.results[0].content.includes('mail-new-access'), false);
  assert.match(exported.results[0].content, new RegExp(account.email));
  assert.equal(exported.mergedContent.includes('mail-new-refresh'), false);
  const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(saved.refreshToken, 'mail-new-refresh');
  assert.equal(saved.stagedCredential, null);
});

test('找回刷新期间兑换会等待，不会下载即将失效的旧凭据', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const service = reclaimService(f.prisma, f.mailbox, async () => {
    entered();
    await gate;
    return { ok: true, credentials: { accessToken: 'race-new-access', refreshToken: 'race-new-refresh' } };
  });
  const reclaiming = service.reclaim({ cards: [account.cardKey], format: 'codex' });
  await started;
  let redeemFinished = false;
  const redeeming = service.redeem({ cards: [account.cardKey], format: 'codex' }).then((result) => {
    redeemFinished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(redeemFinished, false);
  release();
  const [reclaimed, redeemed] = await Promise.all([reclaiming, redeeming]);
  assert.equal(reclaimed.results[0].ok, true);
  assert.equal(redeemed.results[0].ok, true);
  assert.match(redeemed.results[0].content, /race-new-refresh/);
  assert.equal(redeemed.results[0].content.includes('synthetic-openai-refresh'), false);
  assert.match(reclaimed.results[0].content, /race-new-refresh/);
});

test('后台导出使用暂存凭据，不用已经作废的旧凭据', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  await f.prisma.account.update({
    where: { id: account.id },
    data: {
      stagedCredential: JSON.stringify({
        accessToken: 'export-staged-access',
        refreshToken: 'export-staged-refresh',
        idToken: 'export-staged-id',
        expiresAt: null,
        previousRefreshToken: 'synthetic-openai-refresh',
      }),
    },
  });
  const exported = await f.accounts.exportAccounts({ ids: [account.id], format: 'codex' });
  assert.match(exported.content, /export-staged-refresh/);
  assert.equal(exported.content.includes('synthetic-openai-refresh'), false);
  const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(saved.refreshToken, 'export-staged-refresh');
  assert.equal(saved.stagedCredential, null);
});

test('数据库密码里的特殊字符会在连接串里被转义', () => {
  const { postgresDatabaseUrl } = require('../dist/common/database-url');
  const url = postgresDatabaseUrl({
    user: 'card',
    password: 'p@ss:word/a#b?c',
    host: 'postgres',
    database: 'cardline',
  });
  const parsed = new URL(url);
  assert.equal(parsed.username, 'card');
  assert.equal(decodeURIComponent(parsed.password), 'p@ss:word/a#b?c');
  assert.equal(parsed.hostname, 'postgres');
  assert.equal(parsed.pathname, '/cardline');
  assert.equal(parsed.searchParams.get('schema'), 'public');
});

test('兑换日志只记录转发链最后一跳', () => {
  assert.equal(clientAddress({ 'x-forwarded-for': '1.1.1.1, 203.0.113.8' }, '10.0.0.1'), '203.0.113.8');
  assert.equal(clientAddress({ 'x-forwarded-for': ['1.1.1.1', '203.0.113.9'] }, '10.0.0.1'), '203.0.113.9');
  assert.equal(clientAddress({}, '10.0.0.1'), '10.0.0.1');
});

test('暂存连续失败后仍会在锁内再写一次，不会拿旧凭据重刷', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  const original = f.prisma.account.updateMany.bind(f.prisma.account);
  let failures = 0;
  f.prisma.account.updateMany = async (...args) => {
    failures += 1;
    if (failures <= 2) throw new Error('stage failed');
    return original(...args);
  };
  const calls = [];
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    calls.push(token);
    return { ok: true, credentials: { accessToken: 'retry-access', refreshToken: 'retry-refresh' } };
  });
  const result = await service.reclaim({ cards: [account.cardKey], format: 'codex' });
  assert.equal(result.results[0].ok, true);
  assert.deepEqual(calls, ['synthetic-openai-refresh']);
  const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(saved.refreshToken, 'retry-refresh');
  assert.equal(saved.accessToken, 'retry-access');
  f.prisma.account.updateMany = original;
  await service.releaseDeliveredHolds([account.cardKey]);
  const again = await service.reclaim({ cards: [account.cardKey], format: 'codex' });
  assert.equal(again.results[0].ok, true);
  assert.equal(calls[1], 'retry-refresh');
  assert.equal(calls.filter((token) => token === 'synthetic-openai-refresh').length, 1);
});

test('一张卡多个账号时，codex 按账号拆成独立文件，CPA 仍是数组', async (t) => {
  const f = await fixture(t, { limit: 2 });
  const primary = await createAccount(f.prisma, 1);
  await createAccount(f.prisma, 2);
  const codex = await f.redeem.redeem({ cards: [primary.cardKey], format: 'codex', limit: 2 });
  assert.equal(codex.results[0].ok, true);
  assert.equal(codex.results[0].accountCount, 2);
  assert.equal(codex.results[0].content, null);
  assert.equal(codex.results[0].files.length, 2);
  for (const file of codex.results[0].files) {
    const parsed = JSON.parse(file.content);
    assert.equal(Array.isArray(parsed), false);
    assert.equal(parsed.auth_mode, 'chatgpt');
  }
  const cpa = await f.redeem.redeem({ cards: [primary.cardKey], format: 'cpa' });
  assert.equal(Array.isArray(JSON.parse(cpa.results[0].content)), true);
});

test('后台导出多个 codex 账号时打包，邮箱导出不附带 OpenAI JSON', async (t) => {
  const f = await fixture(t);
  const first = await createAccount(f.prisma, 1);
  const second = await createAccount(f.prisma, 2);
  const exported = await f.accounts.exportAccounts({ format: 'codex', ids: [first.id, second.id] });
  assert.equal(exported.contentType, 'application/zip');
  assert.match(exported.filename, /\.zip$/);
  assert.equal(Buffer.isBuffer(exported.content), true);
  assert.equal(exported.content.subarray(0, 2).toString(), 'PK');
  const text = exported.content.toString('utf8');
  assert.match(text, /account1@example.com/);
  assert.match(text, /account2@example.com/);
  const single = await f.accounts.exportAccounts({ format: 'codex', ids: [first.id] });
  assert.equal(single.contentType, 'application/json; charset=utf-8');
  assert.equal(Array.isArray(JSON.parse(single.content)), false);

  await f.prisma.account.update({
    where: { id: first.id },
    data: {
      stagedCredential: JSON.stringify({
        accessToken: 'admin-mail-access',
        refreshToken: 'admin-mail-refresh',
        idToken: null,
        expiresAt: null,
        previousRefreshToken: 'synthetic-openai-refresh',
      }),
    },
  });
  const email = await f.accounts.exportAccounts({ format: 'email', ids: [first.id] });
  assert.match(email.content, new RegExp(first.email));
  assert.equal(String(email.content).includes('admin-mail-access'), false);
  assert.equal(String(email.content).includes('admin-mail-refresh'), false);
  const saved = await f.prisma.account.findUnique({ where: { id: first.id } });
  assert.equal(saved.refreshToken, 'admin-mail-refresh');
});

test('后台刷新没有过期时间时不沿用旧的 expiresAt', async (t) => {
  const f = await fixture(t);
  const stale = new Date('2020-01-01T00:00:00Z');
  const plain = await createAccount(f.prisma, 1, { expiresAt: stale });
  f.mailbox.refreshOpenAiToken = async () => ({
    ok: true,
    accessToken: 'not-a-jwt',
    refreshToken: 'plain-refresh',
  });
  const missed = await f.accounts.refreshStatus({ ids: [plain.id], targets: ['redeem'] });
  assert.equal(missed.redeem.failed, 0);
  const plainSaved = await f.prisma.account.findUnique({ where: { id: plain.id } });
  assert.equal(plainSaved.refreshToken, 'plain-refresh');
  assert.equal(plainSaved.expiresAt, null);

  const exp = Math.trunc(Date.now() / 1000) + 7200;
  const jwtAccount = await createAccount(f.prisma, 2, { expiresAt: stale });
  f.mailbox.refreshOpenAiToken = async () => ({
    ok: true,
    accessToken: jwtWithExp(exp),
    refreshToken: 'jwt-refresh',
  });
  const refreshed = await f.accounts.refreshStatus({ ids: [jwtAccount.id], targets: ['redeem'] });
  assert.equal(refreshed.redeem.failed, 0);
  const jwtSaved = await f.prisma.account.findUnique({ where: { id: jwtAccount.id } });
  assert.equal(jwtSaved.expiresAt.toISOString(), new Date(exp * 1000).toISOString());
});

test('批量邮箱找回时，失败卡的凭据不会带上同批已成功卡', async (t) => {
  const f = await fixture(t);
  const okCard = await createAccount(f.prisma, 1);
  const lostCard = await createAccount(f.prisma, 2);
  await markRedeemed(f.prisma, okCard);
  await markRedeemed(f.prisma, lostCard);
  await f.prisma.account.update({ where: { id: okCard.id }, data: { refreshToken: 'ok-old' } });
  await f.prisma.account.update({ where: { id: lostCard.id }, data: { refreshToken: 'lost-old' } });
  const original = f.prisma.$transaction.bind(f.prisma);
  let transactions = 0;
  f.prisma.$transaction = async (fn, options) => {
    transactions += 1;
    if (transactions >= 2) throw new Error('database write failed');
    return original(fn, options);
  };
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    if (token === 'ok-old') {
      return { ok: true, credentials: { accessToken: 'ok-access-token', refreshToken: 'ok-refresh-token' } };
    }
    return { ok: true, credentials: { accessToken: 'lost-access-token', refreshToken: 'lost-refresh-token' } };
  });
  const result = await service.reclaim({ cards: [okCard.cardKey, lostCard.cardKey], format: 'email' });
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].content.includes('ok-access-token'), false);
  assert.equal(result.results[1].code, 'PERSIST_FAILED');
  assert.match(result.results[1].content, /lost-access-token/);
  assert.match(result.mergedContent, /lost-access-token/);
  assert.match(result.mergedContent, /lost-refresh-token/);
  assert.match(result.mergedContent, /account1@example.com/);
  assert.match(result.mergedContent, /account2@example.com/);
  assert.equal(result.mergedContent.includes('ok-access-token'), false);
  assert.equal(result.mergedContent.includes('ok-refresh-token'), false);

  f.prisma.$transaction = original;
  const kept = await createAccount(f.prisma, 5);
  const partial = await createAccount(f.prisma, 3);
  const extra = await createAccount(f.prisma, 4);
  await markRedeemed(f.prisma, kept);
  await markRedeemed(f.prisma, partial);
  await f.prisma.account.update({ where: { id: kept.id }, data: { refreshToken: 'kept-old' } });
  await f.prisma.account.update({
    where: { id: extra.id },
    data: { redeemStatus: 'redeemed', redeemedByCard: partial.cardKey, redeemedAt: new Date('2026-01-01T00:00:00Z'), refreshToken: 'extra-old' },
  });
  await f.prisma.account.update({ where: { id: partial.id }, data: { refreshToken: 'partial-old' } });
  const mixed = reclaimService(f.prisma, f.mailbox, async (token) => {
    if (token === 'kept-old') return { ok: true, credentials: { accessToken: 'kept-access-token', refreshToken: 'kept-refresh-token' } };
    if (token === 'partial-old') return { ok: true, credentials: { accessToken: 'partial-access-token', refreshToken: 'partial-refresh-token' } };
    return { ok: false, error: 'second failed' };
  });
  const partialResult = await mixed.reclaim({ cards: [kept.cardKey, partial.cardKey], format: 'email' });
  assert.equal(partialResult.results[0].ok, true);
  assert.equal(partialResult.results[1].code, 'REFRESH_FAILED');
  assert.match(partialResult.mergedContent, /partial-refresh-token/);
  assert.match(partialResult.mergedContent, /account5@example.com/);
  assert.equal(partialResult.mergedContent.includes('kept-access-token'), false);
  assert.equal(partialResult.mergedContent.includes('kept-refresh-token'), false);
});

test('后台刷新写库抛错时先暂存，下次不再用旧凭据刷新', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma, 1, { expiresAt: new Date(0) });
  await f.prisma.account.update({
    where: { id: account.id },
    data: { refreshToken: 'current-refresh', accessToken: 'current-access' },
  });
  const originalUpdate = f.prisma.account.updateMany.bind(f.prisma.account);
  f.prisma.account.updateMany = async (args) => {
    if (args?.data?.accessToken === 'thrown-access') throw new Error('database write failed');
    return originalUpdate(args);
  };
  let calls = 0;
  f.mailbox.refreshOpenAiToken = async (token) => {
    calls += 1;
    assert.equal(token, 'current-refresh');
    return {
      ok: true,
      accessToken: 'thrown-access',
      refreshToken: 'thrown-refresh',
      expiresAt: new Date(Date.now() + 3600000),
    };
  };
  const missed = await f.accounts.refreshStatus({ ids: [account.id], targets: ['redeem'] });
  assert.equal(missed.redeem.failed, 1);
  assert.match(missed.items[0].error, /暂存/);
  const still = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(still.refreshToken, 'current-refresh');
  assert.equal(still.banStatus, 'normal');
  assert.match(still.stagedCredential, /thrown-refresh/);
  f.prisma.account.updateMany = originalUpdate;
  f.mailbox.refreshOpenAiToken = async () => {
    throw new Error('暂存凭据不应再次刷新');
  };
  const committed = await f.accounts.refreshStatus({ ids: [account.id], targets: ['redeem'] });
  assert.equal(committed.redeem.failed, 0);
  assert.equal(calls, 1);
  const finalAccount = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(finalAccount.refreshToken, 'thrown-refresh');
  assert.equal(finalAccount.accessToken, 'thrown-access');
  assert.equal(finalAccount.stagedCredential, null);
  assert.equal(finalAccount.banStatus, 'normal');
});

test('导出暂存没有过期时间时不退回旧的 expiresAt', async (t) => {
  const f = await fixture(t);
  const stale = new Date('2020-01-01T00:00:00Z');
  const account = await createAccount(f.prisma, 1, { expiresAt: stale });
  await f.prisma.account.update({
    where: { id: account.id },
    data: {
      stagedCredential: JSON.stringify({
        accessToken: 'staged-export-access',
        refreshToken: 'staged-export-refresh',
        idToken: null,
        expiresAt: null,
        previousRefreshToken: 'synthetic-openai-refresh',
      }),
    },
  });
  const originalUpdate = f.prisma.account.updateMany.bind(f.prisma.account);
  f.prisma.account.updateMany = async (args) => {
    if (args?.data?.accessToken === 'staged-export-access') throw new Error('persist failed');
    return originalUpdate(args);
  };
  const exported = await f.accounts.exportAccounts({ format: 'sub2api', ids: [account.id] });
  assert.match(exported.content, /staged-export-access/);
  assert.match(exported.content, /staged-export-refresh/);
  assert.equal(String(exported.content).includes('1577836800'), false);
  assert.equal(String(exported.content).includes('2020-01-01'), false);
  const saved = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(saved.expiresAt.toISOString(), stale.toISOString());
  assert.match(saved.stagedCredential, /staged-export-refresh/);
});

test('超过 500 张卡密直接拒绝，不静默截断', async (t) => {
  const f = await fixture(t);
  const service = reclaimService(f.prisma, f.mailbox, async () => {
    throw new Error('不应刷新');
  });
  const cards = Array.from({ length: 501 }, (_, index) => `CARD-${index}`);
  await assert.rejects(service.reclaim({ cards }), (error) => {
    assert.equal(error.getResponse().code, 'BAD_INPUT');
    assert.match(error.getResponse().message, /500/);
    return true;
  });
  await assert.rejects(service.redeem({ cards }), (error) => {
    assert.equal(error.getResponse().code, 'BAD_INPUT');
    return true;
  });
});

test('OpenAI 返回 400、401 或客户端错误时不把账号标成凭据失效', async (t) => {
  const f = await fixture(t);
  const request = await createAccount(f.prisma, 1, { expiresAt: new Date(0), refreshToken: 'request-refresh' });
  const client = await createAccount(f.prisma, 2, { expiresAt: new Date(0), refreshToken: 'client-refresh' });
  const geo = await createAccount(f.prisma, 3, { expiresAt: new Date(0), refreshToken: 'geo-refresh' });
  const dead = await createAccount(f.prisma, 4, { expiresAt: new Date(0), refreshToken: 'dead-refresh' });
  const real = f.mailbox.refreshOpenAiToken.bind(f.mailbox);
  f.mailbox.refreshOpenAiToken = async (token) => {
    const previous = global.fetch;
    global.fetch = async () => {
      if (token === 'dead-refresh') {
        return new Response(JSON.stringify({ error: { code: 'invalid_grant', message: 'expired' } }), { status: 400 });
      }
      if (token === 'client-refresh') {
        return new Response(JSON.stringify({ error: 'invalid_client', error_description: 'bad client' }), { status: 401 });
      }
      if (token === 'geo-refresh') {
        return new Response(JSON.stringify({
          error: { code: 'unsupported_country_region_territory', message: 'Country, region, or territory not supported' },
        }), { status: 403 });
      }
      return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'bad scope' }), { status: 400 });
    };
    try {
      return await real(token);
    } finally {
      global.fetch = previous;
    }
  };
  const response = await f.accounts.refreshStatus({
    ids: [request.id, client.id, geo.id, dead.id],
    targets: ['redeem'],
  });
  const byId = new Map(response.items.map((item) => [item.id, item]));
  assert.match(byId.get(request.id).error, /invalid_request/);
  assert.match(byId.get(client.id).error, /invalid_client/);
  assert.match(byId.get(geo.id).error, /unsupported_country_region_territory/);
  assert.match(byId.get(dead.id).error, /invalid_grant/);
  assert.equal((await f.prisma.account.findUnique({ where: { id: request.id } })).banStatus, 'normal');
  assert.equal((await f.prisma.account.findUnique({ where: { id: client.id } })).banStatus, 'normal');
  assert.equal((await f.prisma.account.findUnique({ where: { id: geo.id } })).banStatus, 'normal');
  assert.equal((await f.prisma.account.findUnique({ where: { id: dead.id } })).banStatus, 'invalid');
});

test('后台刷新写库和暂存都失败时，响应带上未落库凭据', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma, 1, { expiresAt: new Date(0) });
  await f.prisma.account.update({
    where: { id: account.id },
    data: { refreshToken: 'current-refresh', accessToken: 'current-access' },
  });
  f.prisma.account.updateMany = async () => {
    throw new Error('database write failed');
  };
  f.mailbox.refreshOpenAiToken = async (token) => {
    assert.equal(token, 'current-refresh');
    return {
      ok: true,
      accessToken: 'unsaved-access',
      refreshToken: 'unsaved-refresh',
      idToken: 'unsaved-id',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    };
  };
  const missed = await f.accounts.refreshStatus({ ids: [account.id], targets: ['redeem'] });
  assert.equal(missed.redeem.failed, 1);
  assert.match(missed.items[0].error, /请立即保存/);
  assert.equal(missed.items[0].unsavedCredential.accessToken, 'unsaved-access');
  assert.equal(missed.items[0].unsavedCredential.refreshToken, 'unsaved-refresh');
  assert.equal(missed.items[0].unsavedCredential.idToken, 'unsaved-id');
  assert.equal(missed.items[0].unsavedCredential.expiresAt, '2030-01-01T00:00:00.000Z');
  const still = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(still.refreshToken, 'current-refresh');
  assert.equal(still.accessToken, 'current-access');
  assert.equal(still.stagedCredential, null);
  assert.equal(still.banStatus, 'normal');
});

test('找回回读失败时响应带上已落库凭据，再次找回不再刷新', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  await f.prisma.account.update({
    where: { id: account.id },
    data: { refreshToken: 'old-refresh', accessToken: 'old-access' },
  });
  let calls = 0;
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    calls += 1;
    assert.equal(token, 'old-refresh');
    return { ok: true, credentials: { accessToken: 'saved-access', refreshToken: 'saved-refresh' } };
  });
  const originalFind = f.prisma.account.findMany.bind(f.prisma.account);
  let blocked = false;
  f.prisma.account.findMany = async (args) => {
    const rows = await originalFind(args);
    if (!blocked && args?.where?.redeemedByCard && rows.some((row) => row.accessToken === 'saved-access')) {
      blocked = true;
      throw new Error('read failed');
    }
    return rows;
  };
  const first = await service.reclaim({ cards: [account.cardKey], format: 'sub2api' });
  assert.equal(calls, 1);
  assert.match(first.results[0].content, /saved-access/);
  assert.match(first.results[0].content, /saved-refresh/);
  assert.match(first.results[0].message, /不会重新刷新/);
  const stored = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(stored.refreshToken, 'saved-refresh');
  assert.equal(stored.refreshHeld, true);
  f.prisma.account.findMany = originalFind;
  const second = await service.reclaim({ cards: [account.cardKey], format: 'sub2api' });
  assert.equal(calls, 1);
  assert.equal(second.results[0].ok, true);
  assert.match(second.results[0].content, /saved-access/);
});

test('找回文件生成失败时保留已落库凭据，恢复后不再刷新', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  await f.prisma.account.update({
    where: { id: account.id },
    data: { refreshToken: 'old-refresh', accessToken: 'old-access' },
  });
  let calls = 0;
  const service = reclaimService(f.prisma, f.mailbox, async () => {
    calls += 1;
    return { ok: true, credentials: { accessToken: 'kept-access', refreshToken: 'kept-refresh' } };
  });
  const original = service.convert.buildDeliverContent.bind(service.convert);
  service.convert.buildDeliverContent = () => {
    throw new Error('pack failed');
  };
  const failed = await service.reclaim({ cards: [account.cardKey], format: 'sub2api' });
  assert.equal(failed.results[0].code, 'INTERNAL');
  assert.equal(failed.results[0].content, null);
  assert.equal(calls, 1);
  const stored = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(stored.accessToken, 'kept-access');
  assert.equal(stored.refreshToken, 'kept-refresh');
  assert.equal(stored.refreshHeld, true);
  service.convert.buildDeliverContent = original;
  const again = await service.reclaim({ cards: [account.cardKey], format: 'sub2api' });
  assert.equal(calls, 1);
  assert.equal(again.results[0].ok, true);
  assert.match(again.results[0].content, /kept-access/);
  assert.match(again.results[0].content, /kept-refresh/);
});

test('管理员初始化日志不包含密码', async (t) => {
  const { prisma } = await fixture(t);
  const seed = new SeedService(prisma);
  const messages = [];
  seed.logger = { log: (message) => messages.push(message) };
  const previous = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = 'synthetic-never-log-this-password';
  try {
    await seed.onModuleInit();
    assert.equal(await prisma.adminUser.count(), 1);
    assert(!messages.join(' ').includes(process.env.ADMIN_PASSWORD));
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous;
  }
});

test('成功找回在响应送达前保持持有，未送达时再次找回不再刷新', async (t) => {
  const f = await fixture(t);
  const account = await createAccount(f.prisma);
  await markRedeemed(f.prisma, account);
  const calls = [];
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    calls.push(token);
    return {
      ok: true,
      credentials: {
        accessToken: calls.length === 1 ? 'delivered-access' : 'second-access',
        refreshToken: calls.length === 1 ? 'delivered-refresh' : 'second-refresh',
      },
    };
  });
  const first = await service.reclaim({ cards: [account.cardKey], format: 'sub2api' });
  assert.equal(first.results[0].ok, true);
  assert.match(first.results[0].content, /delivered-access/);
  const stored = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(stored.refreshToken, 'delivered-refresh');
  assert.equal(stored.refreshHeld, true);
  const second = await service.reclaim({ cards: [account.cardKey], format: 'sub2api' });
  assert.deepEqual(calls, ['synthetic-openai-refresh']);
  assert.equal(second.results[0].ok, true);
  assert.match(second.results[0].content, /delivered-access/);
  assert.equal(second.results[0].content.includes('second-access'), false);
  await service.releaseDeliveredHolds([account.cardKey]);
  const released = await f.prisma.account.findUnique({ where: { id: account.id } });
  assert.equal(released.refreshHeld, false);
  const third = await service.reclaim({ cards: [account.cardKey], format: 'sub2api' });
  assert.equal(third.results[0].ok, true);
  assert.deepEqual(calls, ['synthetic-openai-refresh', 'delivered-refresh']);
  assert.match(third.results[0].content, /second-access/);
});

test('客户端断开后不再继续刷新后续卡，也不解除已写入卡的持有', async (t) => {
  const f = await fixture(t);
  const first = await createAccount(f.prisma, 1);
  const second = await createAccount(f.prisma, 2);
  await markRedeemed(f.prisma, first);
  await markRedeemed(f.prisma, second);
  let stop = false;
  const calls = [];
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    calls.push(token);
    stop = true;
    return { ok: true, credentials: { accessToken: 'stopped-access', refreshToken: 'stopped-refresh' } };
  });
  const result = await service.reclaim({
    cards: [first.cardKey, second.cardKey],
    format: 'sub2api',
    shouldStop: () => stop,
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].card, first.cardKey);
  assert.deepEqual(calls, ['synthetic-openai-refresh']);
  const savedFirst = await f.prisma.account.findUnique({ where: { id: first.id } });
  const savedSecond = await f.prisma.account.findUnique({ where: { id: second.id } });
  assert.equal(savedFirst.refreshToken, 'stopped-refresh');
  assert.equal(savedFirst.refreshHeld, true);
  assert.equal(savedSecond.refreshToken, 'synthetic-openai-refresh');
  assert.equal(savedSecond.refreshHeld, false);
});

test('同卡已持有账号在组包异常收尾时仍进入失败文件', async (t) => {
  const f = await fixture(t);
  const primary = await createAccount(f.prisma, 1);
  const held = await createAccount(f.prisma, 2);
  await markRedeemed(f.prisma, primary);
  await f.prisma.account.update({
    where: { id: primary.id },
    data: { refreshToken: 'old-refresh', accessToken: 'old-access' },
  });
  await f.prisma.account.update({
    where: { id: held.id },
    data: {
      redeemStatus: 'redeemed',
      redeemedByCard: primary.cardKey,
      redeemedAt: new Date('2026-01-01T00:00:00Z'),
      refreshHeld: true,
      accessToken: 'held-access',
      refreshToken: 'held-refresh',
    },
  });
  const calls = [];
  const service = reclaimService(f.prisma, f.mailbox, async (token) => {
    calls.push(token);
    return { ok: true, credentials: { accessToken: 'new-access', refreshToken: 'new-refresh' } };
  });
  const originalFind = f.prisma.account.findMany.bind(f.prisma.account);
  let blockedRead = false;
  f.prisma.account.findMany = async (args) => {
    const rows = await originalFind(args);
    if (!blockedRead && args?.where?.redeemedByCard && rows.some((row) => row.accessToken === 'new-access')) {
      blockedRead = true;
      throw new Error('read failed');
    }
    return rows;
  };
  const originalPack = service.convert.buildDeliverContent.bind(service.convert);
  let packs = 0;
  service.convert.buildDeliverContent = (...args) => {
    packs += 1;
    if (packs === 1) throw new Error('pack failed');
    return originalPack(...args);
  };
  const failed = await service.reclaim({ cards: [primary.cardKey], format: 'sub2api' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'old-refresh');
  assert.equal(failed.results[0].ok, false);
  assert.match(failed.results[0].content, /new-access/);
  assert.match(failed.results[0].content, /new-refresh/);
  assert.match(failed.results[0].content, /held-access/);
  assert.match(failed.results[0].content, /held-refresh/);
  const storedHeld = await f.prisma.account.findUnique({ where: { id: held.id } });
  assert.equal(storedHeld.refreshToken, 'held-refresh');
  assert.equal(storedHeld.refreshHeld, true);
});

test('找回响应写完才解除持有，连接提前关闭不解除', async () => {
  const { EventEmitter } = require('node:events');
  const { PublicController } = require('../dist/public/public.controller');
  function response() {
    const emitter = new EventEmitter();
    emitter.writableFinished = false;
    emitter.writableEnded = false;
    emitter.headersSent = false;
    return emitter;
  }
  function request() {
    return { headers: {}, ip: '127.0.0.1', socket: new EventEmitter() };
  }

  const released = [];
  const delivered = response();
  const deliveredRequest = request();
  const deliveredService = {
    reclaim: async () => ({ results: [{ ok: true, card: 'CARD-OK' }, { ok: false, card: 'CARD-BAD' }] }),
    releaseDeliveredHolds: async (cards) => { released.push(...cards); },
  };
  const deliveredController = new PublicController(deliveredService);
  await deliveredController.reclaim({ cards: ['CARD-OK'], format: 'sub2api' }, deliveredRequest, delivered);
  delivered.writableFinished = true;
  delivered.emit('finish');
  delivered.emit('close');
  assert.deepEqual(released, ['CARD-OK']);

  const dropped = [];
  const closed = response();
  const closedRequest = request();
  let sawStop = false;
  const closedService = {
    reclaim: async (payload) => {
      closedRequest.socket.emit('close');
      sawStop = typeof payload.shouldStop === 'function' && payload.shouldStop() === true;
      return { results: [{ ok: true, card: 'CARD-DROPPED' }] };
    },
    releaseDeliveredHolds: async (cards) => { dropped.push(...cards); },
  };
  const closedController = new PublicController(closedService);
  await closedController.reclaim({ cards: ['CARD-DROPPED'], format: 'sub2api' }, closedRequest, closed);
  closed.writableFinished = true;
  closed.emit('finish');
  assert.equal(sawStop, true);
  assert.deepEqual(dropped, []);
});

test('同一条长连接上连续找回不会堆积 close 监听', async () => {
  const { EventEmitter } = require('node:events');
  const { PublicController } = require('../dist/public/public.controller');
  const socket = new EventEmitter();
  const released = [];
  const service = {
    reclaim: async () => ({ results: [{ ok: true, card: 'CARD-OK' }] }),
    releaseDeliveredHolds: async (cards) => { released.push(...cards); },
  };
  const controller = new PublicController(service);

  for (let index = 0; index < 2; index += 1) {
    const response = new EventEmitter();
    response.writableFinished = false;
    const request = { headers: {}, ip: '127.0.0.1', socket };
    await controller.reclaim({ cards: ['CARD-OK'], format: 'sub2api' }, request, response);
    assert.equal(socket.listenerCount('close'), 0);
    assert.equal(response.listenerCount('close'), 0);
    response.writableFinished = true;
    response.emit('finish');
  }
  assert.deepEqual(released, ['CARD-OK', 'CARD-OK']);

  const dropped = [];
  service.releaseDeliveredHolds = async (cards) => { dropped.push(...cards); };
  service.reclaim = async () => {
    socket.emit('close');
    return { results: [{ ok: true, card: 'CARD-DROPPED' }] };
  };
  const closed = new EventEmitter();
  closed.writableFinished = false;
  await controller.reclaim({ cards: ['CARD-DROPPED'], format: 'sub2api' }, { headers: {}, ip: '127.0.0.1', socket }, closed);
  assert.equal(socket.listenerCount('close'), 0);
  closed.writableFinished = true;
  closed.emit('finish');
  assert.deepEqual(dropped, []);

  service.reclaim = async () => {
    throw new Error('reclaim failed');
  };
  const failed = new EventEmitter();
  failed.writableFinished = false;
  await assert.rejects(
    () => controller.reclaim({ cards: ['CARD-OK'], format: 'sub2api' }, { headers: {}, ip: '127.0.0.1', socket }, failed),
    /reclaim failed/,
  );
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(failed.listenerCount('close'), 0);
});
