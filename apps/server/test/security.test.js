const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

Logger.overrideLogger(false);
global.fetch = async () => { throw new Error('回归测试禁止外部网络请求'); };
const CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const MS_TOKEN = 'M'.repeat(64);

async function fixture(t, { legacy = false, limit = 1 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cardline-regression-'));
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${path.join(directory, 'test.db').replaceAll('\\', '/')}` } } });
  t.after(async () => {
    await prisma.$disconnect();
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 8000;');
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
  await assert.rejects(f.redeem.redeem({ cards: [first.cardKey], format: 'email', limit: 2 }));
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
