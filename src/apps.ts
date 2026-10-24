// 應用程式帳密：給捷徑、腳本等程式以 Basic Auth 呼叫書籤 API，在設定頁新增與刪除。
// 帳號密碼都由伺服器產生，密碼只在建立時回傳一次，D1 只存 SHA-256。
// 密碼是 256 位元亂數，無法暴力猜測，所以不用 PBKDF2 這類慢雜湊，每次 API 呼叫也不必多耗 CPU。
// 每次呼叫記一筆到 app_logs，依各組帳密的保留天數與筆數自動清除
import { hashToken, toBase64Url } from './session';

export const MAX_APP_CREDENTIALS = 20;
const PREFIX = 'app-';
// 最近使用時間最多每小時寫一次 D1
const TOUCH_INTERVAL = 3_600_000;

const encoder = new TextEncoder();

export interface AppCredential {
  id: number;
  username: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  /** 呼叫紀錄保留天數與筆數，超過的在寫入新紀錄時清掉 */
  log_days: number;
  log_limit: number;
}

const COLUMNS = 'id, username, name, created_at, last_used_at, log_days, log_limit';

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function listAppCredentials(db: D1Database): Promise<AppCredential[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM app_credentials ORDER BY id DESC`).all<AppCredential>();
  return results;
}

export async function countAppCredentials(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM app_credentials').first<{ n: number }>();
  return row?.n ?? 0;
}

/** 回傳的 password 是原始密碼，之後無法再查看 */
export async function createAppCredential(db: D1Database, name: string, retention: LogRetention): Promise<{ credential: AppCredential; password: string }> {
  const password = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const credential = await db.prepare(
    `INSERT INTO app_credentials (username, password_hash, name, created_at, log_days, log_limit) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
  )
    .bind(PREFIX + randomHex(6), await hashToken(password), name, new Date().toISOString(), retention.log_days, retention.log_limit)
    .first<AppCredential>();
  return { credential: credential!, password };
}

/** 呼叫紀錄跟著帳密一起刪除 */
export async function deleteAppCredential(db: D1Database, id: number): Promise<boolean> {
  const [, { meta }] = await db.batch([
    db.prepare('DELETE FROM app_logs WHERE app_id = ?').bind(id),
    db.prepare('DELETE FROM app_credentials WHERE id = ?').bind(id),
  ]);
  return meta.changes > 0;
}

export async function verifyAppCredential(db: D1Database, username: string, password: string): Promise<AppCredential | null> {
  if (!username.startsWith(PREFIX)) return null;
  const row = await db.prepare(`SELECT ${COLUMNS}, password_hash FROM app_credentials WHERE username = ?`)
    .bind(username)
    .first<AppCredential & { password_hash: string }>();
  if (!row) return null;
  // 兩邊都是 SHA-256 的 base64url，長度固定相同
  const ok = crypto.subtle.timingSafeEqual(encoder.encode(await hashToken(password)), encoder.encode(row.password_hash));
  if (!ok) return null;
  const { password_hash: _, ...credential } = row;
  return credential;
}

export async function touchAppCredential(db: D1Database, credential: AppCredential): Promise<void> {
  if (credential.last_used_at && Date.now() - Date.parse(credential.last_used_at) < TOUCH_INTERVAL) return;
  await db.prepare('UPDATE app_credentials SET last_used_at = ? WHERE id = ?').bind(new Date().toISOString(), credential.id).run();
}

// 呼叫紀錄：每組帳密各自設定保留天數與筆數
export const LOG_DEFAULTS = { log_days: 7, log_limit: 700 } as const;
export const LOG_MAX = { log_days: 30, log_limit: 10000 } as const;

export type LogRetention = Pick<AppCredential, 'log_days' | 'log_limit'>;

export interface AppLog {
  id: number;
  created_at: string;
  method: string;
  path: string;
  status: number;
  bookmark_id: number | null;
  ip: string;
  user_agent: string;
  duration_ms: number;
}

export async function updateAppCredential(
  db: D1Database, id: number, patch: Partial<Pick<AppCredential, 'name' | 'log_days' | 'log_limit'>>,
): Promise<AppCredential | null> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  const credential = await db.prepare(`UPDATE app_credentials SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? RETURNING ${COLUMNS}`)
    .bind(...keys.map((k) => patch[k]), id)
    .first<AppCredential>();
  // 縮短保留條件時立即生效
  if (credential) await pruneAppLogs(db, credential).run();
  return credential;
}

/** 刪掉超過保留天數，或排在最新 log_limit 筆之後的紀錄 */
function pruneAppLogs(db: D1Database, credential: AppCredential): D1PreparedStatement {
  const since = new Date(Date.now() - credential.log_days * 86_400_000).toISOString();
  return db.prepare(
    'DELETE FROM app_logs WHERE app_id = ? AND (created_at < ? OR id <= (SELECT id FROM app_logs WHERE app_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?))',
  ).bind(credential.id, since, credential.id, credential.log_limit);
}

export async function recordAppLog(db: D1Database, credential: AppCredential, log: Omit<AppLog, 'id' | 'created_at'>): Promise<void> {
  await db.batch([
    db.prepare(
      'INSERT INTO app_logs (app_id, created_at, method, path, status, bookmark_id, ip, user_agent, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(credential.id, new Date().toISOString(), log.method, log.path, log.status, log.bookmark_id, log.ip, log.user_agent, log.duration_ms),
    pruneAppLogs(db, credential),
  ]);
}

export async function listAppLogs(db: D1Database, appId: number, limit: number, offset: number): Promise<{ logs: AppLog[]; total: number }> {
  const [{ results }, count] = await db.batch<unknown>([
    db.prepare('SELECT id, created_at, method, path, status, bookmark_id, ip, user_agent, duration_ms FROM app_logs WHERE app_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .bind(appId, limit, offset),
    db.prepare('SELECT COUNT(*) AS n FROM app_logs WHERE app_id = ?').bind(appId),
  ]);
  return { logs: results as AppLog[], total: (count.results[0] as { n: number }).n };
}
