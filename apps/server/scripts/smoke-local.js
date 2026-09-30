#!/usr/bin/env node
/** PostgreSQL 隔离 schema + 脱敏样例 + 模拟上游的接口联调；--serve 保留服务供页面验证。 */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

const adminUrl = process.env.DATABASE_URL || '';
if (!/^postgres(ql)?:\/\//i.test(adminUrl)) {
  console.error('DATABASE_URL 必须是 PostgreSQL，独立联调不再使用 SQLite');
  process.exit(1);
}
const schemaName = `t_${randomBytes(4).toString('hex')}`;
Object.assign(process.env, {
  NODE_ENV: 'test',
  JWT_SECRET: randomBytes(32).toString('hex'),
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'admin123',
});

const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/app.module');
const { AllExceptionsFilter } = require('../dist/common/all-exceptions.filter');
const { MailboxService } = require('../dist/mailbox/mailbox.service');

global.fetch = async () => { throw new Error('独立联调禁止访问外部服务'); };
MailboxService.prototype.pickupOne = async function(credential) {
  const complete = this.isComplete(credential);
  const email = credential?.email || '';
  return {
    key: email, email, ok: complete, error: complete ? null : '凭据不完整',
    banned: false, banReason: null, banKeywords: [],
    credits: complete ? 2500 : null, creditsBalance: complete ? 100 : null,
    latestCode: complete ? '321654' : null, fetchedAt: new Date().toISOString(),
    messages: complete ? [{
      id: 'synthetic-message', subject: '测试验证码', from: '测试服务 <test@example.com>',
      receivedDateTime: new Date().toISOString(), isRead: false,
      bodyPreview: '验证码 321654', bodyHtml: '<p>验证码 <strong>321654</strong></p>',
      code: '321654', credits: 2500, balance: 100, kind: 'code',
    }] : [],
  };
};
MailboxService.prototype.refreshOpenAiToken = async () => ({
  ok: true, accessToken: 'synthetic-refreshed-access', refreshToken: 'synthetic-refreshed-token',
  expiresAt: new Date(Date.now() + 3600000), invalidCredential: false,
});

let app;
let smokeProcess;
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  if (smokeProcess?.pid && smokeProcess.exitCode === null && smokeProcess.signalCode === null) {
    await new Promise((resolve) => {
      smokeProcess.once('exit', resolve);
      smokeProcess.kill();
    });
  }
  if (app) await app.close();
  const cleanup = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await cleanup.$disconnect();
  process.exitCode = code;
  process.stdin.pause();
}

async function main() {
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
  await admin.$disconnect();
  const scoped = new URL(adminUrl);
  scoped.searchParams.set('schema', schemaName);
  process.env.DATABASE_URL = scoped.toString();
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (process.argv.includes('--serve') && fs.existsSync(path.join(webDist, 'index.html'))) {
    app.useStaticAssets(webDist);
    app.use((request, response, next) => {
      if (request.method === 'GET' && !request.path.startsWith('/api/')) {
        return response.sendFile(path.join(webDist, 'index.html'));
      }
      next();
    });
  }
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  const sample = path.resolve(__dirname, '../../../samples/sub2api.sample.json');
  const code = await new Promise((resolve, reject) => {
    smokeProcess = spawn(process.execPath, [path.join(__dirname, 'smoke-test.js'), `${url}/api`, sample], { stdio: 'inherit' });
    smokeProcess.once('error', reject);
    smokeProcess.once('exit', (status) => resolve(status ?? 1));
  });
  if (code !== 0 || !process.argv.includes('--serve')) return close(code);
  console.log(`ISOLATED_SERVER ${url} PID=${process.pid}（仅虚构数据；输入 stop 关闭）`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    if (data.trim() === 'stop') void close();
  });
  process.stdin.resume();
}

process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
main().catch(async (error) => {
  console.error(error);
  await close(1);
});
