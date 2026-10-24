// 瀏覽器登入的 Session。登入頁以密碼或 Passkey 換 Cookie；程式呼叫不經登入頁，照舊帶 Basic Auth
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export const SESSION_DAYS = 30;
const DAY = 86_400_000;
const COOKIE = 'session';

export type SessionMethod = 'password' | 'passkey';

export interface Session {
  id: string;
  token: string;
  /** 距上次延長超過一天，回應時要延長效期並重發 Cookie */
  renew: boolean;
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** D1 只存 token 的雜湊，資料庫外洩也拿不到可用的 Cookie */
async function hashToken(token: string): Promise<string> {
  return toBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

function expiresAt(): string {
  return new Date(Date.now() + SESSION_DAYS * DAY).toISOString();
}

// 一定要給 Max-Age：iOS 主畫面 App（PWA）被系統關掉後，沒有效期的 Cookie 會跟著消失，等於每次開啟都要重新登入。
// SameSite=Lax：從通知信、其他 App 分享進來的頂層導覽要帶得到 Cookie；跨站的 POST 與 fetch 不帶，寫入 API 另有同源檢查
function writeCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, { prefix: 'host', httpOnly: true, sameSite: 'Lax', maxAge: SESSION_DAYS * DAY / 1000 });
}

export async function createSession<E extends { Bindings: Env }>(c: Context<E>, method: SessionMethod): Promise<void> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date().toISOString();
  const db = c.env.DB;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('INSERT INTO sessions (id, method, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await hashToken(token), method, (c.req.header('User-Agent') ?? '').slice(0, 300), now, expiresAt()),
  ]);
  writeCookie(c, token);
}

export async function readSession<E extends { Bindings: Env }>(c: Context<E>): Promise<Session | null> {
  const token = getCookie(c, COOKIE, 'host');
  if (!token) return null;
  const id = await hashToken(token);
  const row = await c.env.DB.prepare('SELECT expires_at FROM sessions WHERE id = ? AND expires_at > ?')
    .bind(id, new Date().toISOString())
    .first<{ expires_at: string }>();
  if (!row) return null;
  return { id, token, renew: Date.parse(row.expires_at) - Date.now() < (SESSION_DAYS - 1) * DAY };
}

/** 使用中的 Session 往後延 30 天，最多每天寫一次 D1 */
export async function renewSession<E extends { Bindings: Env }>(c: Context<E>, session: Session): Promise<void> {
  await c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(expiresAt(), session.id).run();
  writeCookie(c, session.token);
}

export async function destroySession<E extends { Bindings: Env }>(c: Context<E>): Promise<void> {
  const token = getCookie(c, COOKIE, 'host');
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await hashToken(token)).run();
  deleteCookie(c, COOKIE, { prefix: 'host' });
}

/** 登出其他裝置；keepId 為空（例如以 Basic Auth 呼叫）時全部登出 */
export async function destroyOtherSessions(db: D1Database, keepId?: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id != ?').bind(keepId ?? '').run();
}

export async function countSessions(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?').bind(new Date().toISOString()).first<{ n: number }>();
  return row?.n ?? 0;
}
