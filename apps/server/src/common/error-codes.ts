export type ErrorCode =
  | 'BAD_INPUT'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CARD_INVALID'
  | 'CARD_DISABLED'
  | 'CARD_NOT_REDEEMED'
  | 'CARD_ALLOCATED'
  | 'CREDITS_PENDING'
  | 'NO_STOCK'
  | 'REFRESH_MISSING'
  | 'REFRESH_FAILED'
  | 'PERSIST_FAILED'
  | 'PICKUP_FAILED'
  | 'UPSTREAM_ERROR'
  | 'CONFLICT'
  | 'INTERNAL';

export type DeliverBundle = 'document' | 'zip';

export type DeliverFormat =
  | 'sub2api'
  | 'cpa'
  | 'cockpit'
  | 'ninerouter'
  | 'codex'
  | 'axonhub'
  | 'codex-manager'
  | 'email';
export type BanStatus = 'unknown' | 'normal' | 'banned' | 'invalid';
export type RedeemStatus = 'unredeemed' | 'redeemed';
export type ImportSource = 'paste' | 'upload';
export type MessageKind = 'code' | 'credits' | 'ban' | 'normal';

export const DELIVER_FORMATS: DeliverFormat[] = [
  'sub2api',
  'cpa',
  'cockpit',
  'ninerouter',
  'codex',
  'axonhub',
  'codex-manager',
  'email',
];
export const BAN_STATUSES: BanStatus[] = ['unknown', 'normal', 'banned', 'invalid'];
export const REDEEM_STATUSES: RedeemStatus[] = ['unredeemed', 'redeemed'];

export function isDeliverFormat(value: unknown): value is DeliverFormat {
  return typeof value === 'string' && DELIVER_FORMATS.includes(value as DeliverFormat);
}

export const FORMAT_META: Record<
  DeliverFormat,
  { label: string; ext: string; title: string; hint: string; bundle: DeliverBundle }
> = {
  sub2api: {
    label: 'sub2api',
    ext: 'json',
    title: 'sub2api',
    hint: 'sub2api 导入 JSON（exported_at / proxies / accounts）',
    bundle: 'document',
  },
  cpa: {
    label: 'CPA',
    ext: 'json',
    title: 'CPA',
    hint: 'Codex CPA auth JSON（type: codex + access_token/id_token）',
    bundle: 'zip',
  },
  cockpit: {
    label: 'Cockpit Tools',
    ext: 'json',
    title: 'Cockpit Tools',
    hint: 'Cockpit Tools 账号 JSON，多张卡打包成 zip',
    bundle: 'zip',
  },
  ninerouter: {
    label: '9router',
    ext: 'json',
    title: '9router',
    hint: '9router 账号 JSON，多张卡打包成 zip',
    bundle: 'zip',
  },
  codex: {
    label: 'Codex auth.json',
    ext: 'json',
    title: 'Codex auth.json',
    hint: 'Codex CLI auth.json，多张卡打包成 zip',
    bundle: 'zip',
  },
  axonhub: {
    label: 'AxonHub',
    ext: 'json',
    title: 'AxonHub',
    hint: 'AxonHub auth.json，多张卡打包成 zip',
    bundle: 'zip',
  },
  'codex-manager': {
    label: 'Codex-Manager',
    ext: 'json',
    title: 'Codex-Manager',
    hint: 'Codex-Manager 凭据 JSON，多张卡打包成 zip',
    bundle: 'zip',
  },
  email: {
    label: '邮箱 TXT',
    ext: 'txt',
    title: '邮箱 TXT',
    hint: '四段邮箱凭据；有 ChatGPT 密码或 2FA 时导出六段',
    bundle: 'document',
  },
};
