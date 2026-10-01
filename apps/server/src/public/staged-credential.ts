/** 刷新已经成功、但当前凭据列还没写成新值时，暂存在这一列里。再次找回先提交它，不再拿旧凭据去刷新。 */
export type StagedCredential = {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: string | null;
  previousRefreshToken: string;
};

export function serializeStagedCredential(write: {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: Date | null;
  previousRefreshToken: string;
}): string {
  return JSON.stringify({
    accessToken: write.accessToken,
    refreshToken: write.refreshToken,
    idToken: write.idToken,
    expiresAt: write.expiresAt instanceof Date && !Number.isNaN(write.expiresAt.getTime()) ? write.expiresAt.toISOString() : null,
    previousRefreshToken: write.previousRefreshToken,
  });
}

export function parseStagedCredential(raw: string | null | undefined): StagedCredential | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken.trim()) return null;
    if (typeof parsed.refreshToken !== 'string' || !parsed.refreshToken.trim()) return null;
    if (typeof parsed.previousRefreshToken !== 'string' || !parsed.previousRefreshToken) return null;
    const expiresAt = typeof parsed.expiresAt === 'string' && parsed.expiresAt.trim() ? parsed.expiresAt.trim() : null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      idToken: typeof parsed.idToken === 'string' && parsed.idToken.trim() ? parsed.idToken.trim() : null,
      expiresAt,
      previousRefreshToken: parsed.previousRefreshToken,
    };
  } catch {
    return null;
  }
}

/** 只有暂存仍然对应当前库里的旧刷新凭据时才采用，避免盖住已经写成功的新凭据。 */
export function stagedForAccount(account: {
  refreshToken?: string | null;
  stagedCredential?: string | null;
}): StagedCredential | null {
  const staged = parseStagedCredential(account.stagedCredential);
  if (!staged || !account.refreshToken || staged.previousRefreshToken !== account.refreshToken) return null;
  return staged;
}

export function stagedExpiresAt(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
