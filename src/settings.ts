// 個人設定與登入帳密。帳密只由 wrangler 的 AUTH_USER／AUTH_PASS 設定，設定頁不能修改

const encoder = new TextEncoder();

export interface Credentials {
  username: string;
  password: string;
}

export async function getSettings(db: D1Database, keys: string[]): Promise<Record<string, string>> {
  const { results } = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((row) => [row.key, row.value]));
}

export async function putSettings(db: D1Database, entries: Record<string, string>): Promise<void> {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  await db.batch(Object.entries(entries).map(([key, value]) => stmt.bind(key, value)));
}

export async function loadCredentials(env: Env): Promise<Credentials | null> {
  if (!env.AUTH_PASS) return null;
  return { username: env.AUTH_USER || 'admin', password: env.AUTH_PASS };
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

/** 先各自雜湊成等長再比較，長度不同也不會提早結束 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  return crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b));
}

export async function checkCredentials(creds: Credentials, username: string, password: string): Promise<boolean> {
  const userOk = await safeEqual(username, creds.username);
  return (await safeEqual(password, creds.password)) && userOk;
}
