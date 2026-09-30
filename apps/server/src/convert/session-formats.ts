/**
 * Ported from GPTSession2CPAandSub2API
 * https://github.com/gtxx3600/GPTSession2CPAandSub2API
 * Copyright (c) 2026 Dehujiaogeli
 * SPDX-License-Identifier: MIT
 *
 * 只搬 convertSession 和它调用的纯函数。
 * sub2api、CPA、邮箱 TXT 的顾客交付仍使用 ConvertService 里的原实现。
 */
import type {
  AxonHubAuthDocument,
  CockpitAccount,
  CodexAuthDocument,
  CodexManagerAuthDocument,
  NormalizedAccount,
  SessionFormatBundle,
} from './convert.types';

const AXONHUB_PLACEHOLDER_REFRESH_TOKEN = '__missing_refresh_token__';

type JsonRecord = Record<string, any>;

function isPlainObject(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function parseJwtPayload(token: unknown): JsonRecord | undefined {
  if (typeof token !== 'string' || token.trim() === '') {
    return undefined;
  }
  const segments = token.split('.');
  if (segments.length < 2) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(decodeBase64Url(segments[1]));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function getOpenAIAuthSection(payload: unknown): JsonRecord {
  if (!isPlainObject(payload)) return {};
  const auth = payload['https://api.openai.com/auth'];
  return isPlainObject(auth) ? auth : {};
}

function getOpenAIProfileSection(payload: unknown): JsonRecord {
  if (!isPlainObject(payload)) return {};
  const profile = payload['https://api.openai.com/profile'];
  return isPlainObject(profile) ? profile : {};
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1e11 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function timestampFromUnixSeconds(value: unknown): string | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const date = new Date(numeric * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function unixSecondsFromJwtExp(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.trunc(numeric);
}

function epochSecondsFromValue(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric > 1e11 ? numeric / 1000 : numeric);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : 0;
}

function buildSyntheticCodexIdToken(
  email: string | undefined,
  accountId: string | undefined,
  planType: string | undefined,
  userId: string | undefined,
  expiresAt: string | undefined,
): string | undefined {
  if (!accountId) return undefined;
  const now = Math.trunc(Date.now() / 1000);
  const authInfo: JsonRecord = { chatgpt_account_id: accountId };
  const expires = epochSecondsFromValue(expiresAt) || now + 90 * 24 * 60 * 60;
  if (planType) authInfo.chatgpt_plan_type = planType;
  if (userId) {
    authInfo.chatgpt_user_id = userId;
    authInfo.user_id = userId;
  }
  const payload: JsonRecord = {
    iat: now,
    exp: expires,
    'https://api.openai.com/auth': authInfo,
  };
  if (email) payload.email = email;
  return `${encodeBase64UrlJson({ alg: 'none', typ: 'JWT', cpa_synthetic: true })}.${encodeBase64UrlJson(payload)}.synthetic`;
}

function getExpiresIn(expiresAt: string | undefined, now = new Date()): number | undefined {
  if (!expiresAt) return undefined;
  const expiresMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresMs)) return undefined;
  return Math.max(0, Math.floor((expiresMs - now.getTime()) / 1000));
}

function getAxonHubLastRefresh(expiresAt: string | undefined, now = new Date()): string | undefined {
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (Number.isNaN(expiresMs)) return normalizeTimestamp(now);
  return new Date(expiresMs - 60 * 60 * 1000).toISOString();
}

function stripUnavailable(value: unknown): any {
  if (Array.isArray(value)) {
    return value.map(stripUnavailable).filter((item) => item !== undefined);
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, stripUnavailable(item)])
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (value === undefined || value === null || value === '') return undefined;
  return value;
}

function toEmailKey(email: unknown): string | undefined {
  if (typeof email !== 'string') return undefined;
  return email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function definedRecord(entries: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined && value !== null),
  );
}

export interface ConvertSessionOptions {
  now?: Date;
  sourceName?: string;
  sourcePath?: string;
}

/** 纯函数：一份 session 记录转出参考仓库里的 7 种 JSON。 */
export function convertSession(record: unknown, options: ConvertSessionOptions = {}): SessionFormatBundle {
  if (!isPlainObject(record)) {
    throw new Error('session 不是 JSON 对象');
  }

  const accessToken = firstNonEmpty(
    record.accessToken,
    record.access_token,
    record.tokens?.accessToken,
    record.tokens?.access_token,
    record.token?.accessToken,
    record.token?.access_token,
    record.credentials?.accessToken,
    record.credentials?.access_token,
  );
  if (!accessToken) throw new Error('缺少 accessToken');

  const sessionToken = firstNonEmpty(
    record.sessionToken,
    record.session_token,
    record.tokens?.sessionToken,
    record.tokens?.session_token,
    record.token?.sessionToken,
    record.token?.session_token,
    record.credentials?.session_token,
  );
  const refreshToken = firstNonEmpty(
    record.refreshToken,
    record.refresh_token,
    record.tokens?.refreshToken,
    record.tokens?.refresh_token,
    record.token?.refreshToken,
    record.token?.refresh_token,
    record.credentials?.refresh_token,
  );
  const inputIdToken = firstNonEmpty(
    record.idToken,
    record.id_token,
    record.tokens?.idToken,
    record.tokens?.id_token,
    record.token?.idToken,
    record.token?.id_token,
    record.credentials?.id_token,
  );

  const payload = parseJwtPayload(accessToken);
  const idPayload = parseJwtPayload(inputIdToken);
  const auth = getOpenAIAuthSection(payload);
  const idAuth = getOpenAIAuthSection(idPayload);
  const profile = getOpenAIProfileSection(payload);
  const hasRefreshToken = Boolean(refreshToken);
  const accessTokenExpiresAt = hasRefreshToken ? undefined : unixSecondsFromJwtExp(payload?.exp);
  const expiresAt = hasRefreshToken
    ? undefined
    : firstNonEmpty(
        payload ? timestampFromUnixSeconds(payload.exp) : undefined,
        normalizeTimestamp(record.expires),
        normalizeTimestamp(record.expiresAt),
        normalizeTimestamp(record.expired),
        normalizeTimestamp(record.expires_at),
      );
  const email = firstNonEmpty(
    record.user?.email,
    record.email,
    record.meta?.label,
    record.label,
    record.credentials?.email,
    record.providerSpecificData?.email,
    profile.email,
    idPayload?.email,
    payload?.email,
  );
  const accountId = firstNonEmpty(
    record.account?.id,
    record.account_id,
    record.tokens?.accountId,
    record.tokens?.account_id,
    record.chatgptAccountId,
    record.chatgpt_account_id,
    record.meta?.chatgptAccountId,
    record.meta?.chatgpt_account_id,
    record.tokens?.chatgptAccountId,
    record.tokens?.chatgpt_account_id,
    record.providerSpecificData?.chatgptAccountId,
    record.providerSpecificData?.chatgpt_account_id,
    record.credentials?.chatgpt_account_id,
    auth.chatgpt_account_id,
    idAuth.chatgpt_account_id,
    record.provider === 'codex' ? record.id : undefined,
  );
  const chatgptAccountId = firstNonEmpty(
    record.chatgptAccountId,
    record.chatgpt_account_id,
    record.meta?.chatgptAccountId,
    record.meta?.chatgpt_account_id,
    record.tokens?.chatgptAccountId,
    record.tokens?.chatgpt_account_id,
    record.providerSpecificData?.chatgptAccountId,
    record.providerSpecificData?.chatgpt_account_id,
    record.credentials?.chatgpt_account_id,
    auth.chatgpt_account_id,
    idAuth.chatgpt_account_id,
  );
  const workspaceId = firstNonEmpty(
    record.account?.workspaceId,
    record.account?.workspace_id,
    record.workspaceId,
    record.workspace_id,
    record.meta?.workspaceId,
    record.meta?.workspace_id,
    record.providerSpecificData?.workspaceId,
    record.providerSpecificData?.workspace_id,
    record.credentials?.workspace_id,
    payload?.workspace_id,
    idPayload?.workspace_id,
  );
  const userId = firstNonEmpty(
    record.user?.id,
    record.user_id,
    record.chatgptUserId,
    record.providerSpecificData?.chatgptUserId,
    record.providerSpecificData?.chatgpt_user_id,
    auth.chatgpt_user_id,
    auth.user_id,
    idAuth.chatgpt_user_id,
    idAuth.user_id,
  );
  const planType = firstNonEmpty(
    record.account?.planType,
    record.account?.plan_type,
    record.planType,
    record.plan_type,
    record.providerSpecificData?.chatgptPlanType,
    record.providerSpecificData?.chatgpt_plan_type,
    record.credentials?.plan_type,
    auth.chatgpt_plan_type,
    idAuth.chatgpt_plan_type,
  );
  const now = options.now || new Date();
  const exportedAt = normalizeTimestamp(now);
  const expiresIn = getExpiresIn(expiresAt, now);
  const sourceName = firstNonEmpty(options.sourceName, 'pasted-json');
  const sourceType = record.provider === 'codex' && record.authType === 'oauth' ? '9router' : 'chatgpt_web_session';
  const name = firstNonEmpty(email, sourceName, 'ChatGPT Account');
  const syntheticIdToken = !inputIdToken
    ? buildSyntheticCodexIdToken(email, accountId, planType, userId, expiresAt)
    : undefined;
  const idToken = firstNonEmpty(inputIdToken, syntheticIdToken);

  const cpa = definedRecord({
    type: 'codex',
    account_id: accountId,
    chatgpt_account_id: accountId,
    email,
    name,
    plan_type: planType,
    chatgpt_plan_type: planType,
    id_token: idToken,
    id_token_synthetic: Boolean(syntheticIdToken) || undefined,
    access_token: accessToken,
    refresh_token: refreshToken || '',
    session_token: sessionToken,
    last_refresh: exportedAt,
    expired: expiresAt,
    disabled: Boolean(record.disabled) || undefined,
  });

  const cockpit: CockpitAccount = {
    type: 'codex',
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken || '',
    account_id: accountId,
    last_refresh: exportedAt,
    email,
    expired: expiresAt,
    account_note: firstNonEmpty(
      record.account_note,
      record.accountInfo,
      record.account_info,
      record.note,
      record.notes,
      record.remark,
    ),
  };

  const sub2apiAccount = stripUnavailable({
    name: firstNonEmpty(name, email, sourceName, 'ChatGPT Account'),
    platform: 'openai',
    type: 'oauth',
    expires_at: accessTokenExpiresAt,
    auto_pause_on_expired: accessTokenExpiresAt ? true : undefined,
    concurrency: 10,
    priority: 1,
    credentials: {
      access_token: accessToken,
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
      email,
      expires_at: expiresAt,
      expires_in: expiresIn,
      plan_type: planType,
    },
    extra: {
      email,
      email_key: toEmailKey(email),
      name,
      auth_provider: firstNonEmpty(record.authProvider, record.auth_provider),
      source: sourceType,
      last_refresh: exportedAt,
    },
  });

  const priority = Number.isFinite(Number(record.priority)) ? Number(record.priority) : 9;
  const isActive = typeof record.isActive === 'boolean' ? record.isActive : !Boolean(record.disabled);
  const createdAt = normalizeTimestamp(record.createdAt) || exportedAt;
  const updatedAt = normalizeTimestamp(record.updatedAt) || exportedAt;
  const nineRouter = stripUnavailable({
    accessToken,
    refreshToken,
    expiresAt,
    testStatus: firstNonEmpty(record.testStatus, record.test_status, 'active'),
    expiresIn,
    providerSpecificData: {
      chatgptAccountId: accountId,
      chatgptPlanType: planType,
    },
    id: accountId,
    provider: 'codex',
    authType: 'oauth',
    name,
    email,
    priority,
    isActive,
    createdAt,
    updatedAt,
  });

  const axonHubRefreshToken = refreshToken || AXONHUB_PLACEHOLDER_REFRESH_TOKEN;
  const codexAuthJson: CodexAuthDocument = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken || '',
      account_id: accountId,
    },
    last_refresh: exportedAt,
  };
  const axonHub: AxonHubAuthDocument = stripUnavailable({
    auth_mode: 'chatgpt',
    last_refresh: getAxonHubLastRefresh(expiresAt, now),
    tokens: {
      access_token: accessToken,
      refresh_token: axonHubRefreshToken,
      id_token: idToken,
    },
    axonhub_refresh_token_placeholder: refreshToken ? undefined : true,
    axonhub_note: refreshToken
      ? undefined
      : 'refresh_token is a placeholder; access_token works only until it expires.',
  });
  const codexManagerTokenHints = Object.fromEntries(
    Object.entries({
      account_id: accountId,
      chatgpt_account_id: chatgptAccountId,
    }).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
  const codexManagerMeta = Object.fromEntries(
    Object.entries({
      label: firstNonEmpty(name, email, sourceName, 'ChatGPT Account'),
      workspace_id: workspaceId,
      chatgpt_account_id: chatgptAccountId,
      note: 'Imported from ChatGPT session',
    }).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
  const codexManager: CodexManagerAuthDocument = {
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken || '',
      id_token: inputIdToken || '',
      ...codexManagerTokenHints,
    },
    meta: codexManagerMeta,
  };

  return {
    sourceName,
    sourcePath: options.sourcePath,
    email,
    name,
    expiresAt,
    accessTokenExpiresAt,
    cpa,
    cockpit,
    nineRouter,
    codexAuthJson,
    axonHub,
    codexManager,
    sub2apiAccount,
  };
}

function publicNote(value: unknown): string | undefined {
  const text = firstNonEmpty(value);
  if (!text) return undefined;
  if (text.includes('----') || /refresh_token|password|client_id|two_factor/i.test(text)) {
    return undefined;
  }
  return text;
}

/** 库存账号只提供转换所需字段，不把邮箱凭据 notes 送进新格式。 */
export function sessionFromNormalized(account: NormalizedAccount): JsonRecord {
  const raw = isPlainObject(account.raw) ? account.raw : {};
  const extra = isPlainObject(account.extra) ? account.extra : {};
  return {
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    idToken: account.idToken,
    sessionToken: account.sessionToken,
    email: account.email,
    user: { email: account.email, id: account.userId },
    account: {
      id: account.accountId,
      planType: account.planType,
      workspaceId: firstNonEmpty(raw.workspaceId, raw.workspace_id, extra.workspaceId, extra.workspace_id),
    },
    expires: account.expiresAt,
    expiresAt: account.expiresAt,
    chatgptAccountId: firstNonEmpty(
      raw.chatgptAccountId,
      raw.chatgpt_account_id,
      extra.chatgptAccountId,
      extra.chatgpt_account_id,
    ),
    workspaceId: firstNonEmpty(raw.workspaceId, raw.workspace_id, extra.workspaceId, extra.workspace_id),
    disabled: raw.disabled,
    priority: raw.priority,
    isActive: raw.isActive,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    account_note: publicNote(raw.account_note) || publicNote(raw.accountInfo) || publicNote(raw.remark),
    authProvider: firstNonEmpty(raw.authProvider, raw.auth_provider, extra.auth_provider),
    provider: raw.provider,
    authType: raw.authType,
    testStatus: firstNonEmpty(raw.testStatus, raw.test_status),
  };
}

export function convertNormalizedAccount(
  account: NormalizedAccount,
  options: ConvertSessionOptions = {},
): SessionFormatBundle {
  return convertSession(sessionFromNormalized(account), options);
}
