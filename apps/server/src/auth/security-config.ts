import { randomBytes } from 'node:crypto';

const DEFAULT_SECRETS = new Set([
  'cardline-dev-secret-change-me',
  'cardline-please-change-this-secret',
  'change-me-in-production',
]);
const developmentSecret = randomBytes(32).toString('hex');

export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  const valid = Boolean(secret && secret.length >= 32 && !DEFAULT_SECRETS.has(secret));
  if (process.env.NODE_ENV === 'production' && !valid) {
    throw new Error('生产环境必须设置独立的 JWT_SECRET（至少 32 个字符，禁止使用默认值）');
  }
  // 开发环境未配置有效密钥时只使用本进程随机密钥，不接受公开的固定签名密钥。
  return valid ? secret : developmentSecret;
}

export function initialAdminPassword(): string {
  const password = process.env.ADMIN_PASSWORD || '';
  if (process.env.NODE_ENV === 'production' && (password.length < 12 || password === 'admin123')) {
    throw new Error('首次生产启动必须设置 ADMIN_PASSWORD（至少 12 个字符）');
  }
  return password || 'admin123';
}
