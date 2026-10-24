// 個人設定與登入帳密。帳密在設定頁存過一次後以 D1 為準，wrangler 的 AUTH_USER／AUTH_PASS 只在 D1 沒有時使用

const ITERATIONS = 100_000;
const encoder = new TextEncoder();

export interface Credentials {
  username: string;
  source: 'database' | 'env';
  /** source 為 database 時：pbkdf2-sha256$次數$salt$hash */
  hash?: string;
  /** source 為 env 時的明文密碼 */
  password?: string;
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
  let stored: Record<string, string> = {};
  try {
    stored = await getSettings(env.DB, ['auth_user', 'auth_hash']);
  } catch (err) {
    // 尚未套用 0002 migration 時沿用環境變數；其他 D1 錯誤不放寬，直接拋出
    if (!String(err).includes('no such table')) throw err;
  }
  if (stored.auth_user && stored.auth_hash) return { username: stored.auth_user, hash: stored.auth_hash, source: 'database' };
  if (env.AUTH_PASS) return { username: env.AUTH_USER || 'admin', password: env.AUTH_PASS, source: 'env' };
  return null;
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

/** 先各自雜湊成等長再比較，長度不同也不會提早結束 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  return crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(await pbkdf2(password, salt, ITERATIONS))}`;
}

async function verifyHash(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256' || !salt || !hash) return false;
  const derived = await pbkdf2(password, fromBase64(salt), Number(iterations));
  return crypto.subtle.timingSafeEqual(derived, fromBase64(hash));
}

// PBKDF2 很吃 CPU，每個請求都會驗證一次；同一個 isolate 內驗過的組合記住雜湊值，帳密變更後 auth_hash 不同自然失效
const verified = new Set<string>();

export async function checkCredentials(creds: Credentials, username: string, password: string): Promise<boolean> {
  const userOk = await safeEqual(username, creds.username);
  if (creds.source === 'env') return (await safeEqual(password, creds.password ?? '')) && userOk;

  const cacheKey = `${creds.hash}$${toBase64(await sha256(`${username}:${password}`))}`;
  if (verified.has(cacheKey)) return true;
  const ok = (await verifyHash(password, creds.hash ?? '')) && userOk;
  if (ok) {
    if (verified.size > 20) verified.clear();
    verified.add(cacheKey);
  }
  return ok;
}

export async function saveCredentials(db: D1Database, username: string, password: string): Promise<void> {
  await putSettings(db, { auth_user: username, auth_hash: await hashPassword(password) });
}
