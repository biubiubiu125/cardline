/** 从 access token 的 JWT `exp` 取过期时间。不是 JWT 或没有 `exp` 时返回 null。 */
export function expiresAtFromJwt(token: string | null | undefined): Date | null {
  if (!token || !token.includes('.')) return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    const exp = Number(claims.exp);
    if (!Number.isFinite(exp)) return null;
    return new Date(exp * 1000);
  } catch {
    return null;
  }
}
