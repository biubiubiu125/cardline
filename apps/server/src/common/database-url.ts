/** 用独立字段组装 PostgreSQL 连接串，避免密码里的 @ : / # ? 把 URL 拆坏。 */
export function postgresDatabaseUrl(input: {
  user: string;
  password: string;
  host: string;
  port?: string;
  database: string;
  schema?: string;
}): string {
  const user = encodeURIComponent(input.user || '');
  const password = encodeURIComponent(input.password || '');
  const database = encodeURIComponent(input.database || '');
  const host = String(input.host || '').trim();
  const port = String(input.port || '5432').trim() || '5432';
  const schema = encodeURIComponent(input.schema || 'public');
  if (!user || !host || !database) throw new Error('PostgreSQL 连接参数不完整');
  return `postgresql://${user}:${password}@${host}:${port}/${database}?schema=${schema}`;
}
