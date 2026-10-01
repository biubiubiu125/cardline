import { Client } from 'pg';

/** 同时进行的找回次数。每张卡单独占一条连接，避免把数据库连接池打满。 */
const RECLAIM_SLOTS = 8;
let activeReclaims = 0;
const slotWaiters: Array<() => void> = [];

function acquireReclaimSlot(): Promise<void> {
  if (activeReclaims >= RECLAIM_SLOTS) {
    return new Promise((resolve) => {
      slotWaiters.push(resolve);
    });
  }
  activeReclaims += 1;
  return Promise.resolve();
}

function releaseReclaimSlot(): void {
  const next = slotWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeReclaims -= 1;
}

/** Prisma 的 schema 参数不是 pg 的连接参数，交给独立连接前去掉。 */
export function postgresUrlForLock(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.delete('schema');
  return url.toString();
}

/**
 * 按「当前 schema + 卡密」持有会话级咨询锁，直到 fn 结束。
 * 刷新和写库重试都在锁内，另一张找回不能读到同一个旧凭据。
 * 连接断开时数据库会释放这把锁。
 */
/** 找回和后台刷新共用同一把卡锁，避免两边拿同一个旧刷新凭据去轮换。 */
export async function withReclaimLock<T>(
  prisma: { $queryRaw: Function },
  cardKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const databaseUrl = String(process.env.DATABASE_URL || '');
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) throw new Error('DATABASE_URL 必须是 PostgreSQL');
  const rows = await prisma.$queryRaw`SELECT current_schema() AS schema`;
  const schema = String(rows[0]?.schema || 'public');
  return withReclaimCardLock(postgresUrlForLock(databaseUrl), `cardline-reclaim:${schema}:${cardKey}`, fn);
}

export async function withReclaimCardLock<T>(
  databaseUrl: string,
  lockName: string,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireReclaimSlot();
  const client = new Client({ connectionString: databaseUrl });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [lockName]);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [lockName]);
    }
  } finally {
    if (connected) await client.end().catch(() => undefined);
    releaseReclaimSlot();
  }
}
