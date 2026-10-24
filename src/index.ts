import { Hono, type Context } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { HTTPException } from 'hono/http-exception';
import { aiEnabled } from './ai';
import {
  countAppCredentials, createAppCredential, deleteAppCredential, listAppCredentials, listAppLogs, LOG_DEFAULTS, LOG_MAX, MAX_APP_CREDENTIALS, recordAppLog,
  touchAppCredential, updateAppCredential, verifyAppCredential, type AppCredential, type LogRetention,
} from './apps';
import { CrawlError, normalizeUrl, safeUrl } from './crawler';
import {
  deleteBookmark, findIdByUrl, getBookmark, getOverview, insertBookmark, listBookmarks, normalizeTags, recordClick,
  updateBookmark, type BookmarkPatch,
} from './db';
import { buildDraft } from './enrich';
import { EXTRACTORS } from './extractors';
import { isEmail, loadMailSettings, MAX_RECIPIENTS, saveMailSettings, sendBookmarkMail } from './mailer';
import { checkCredentials, getSettings, loadCredentials, putSettings, type Credentials } from './settings';
import { hostOf, siteOf } from './sites';
import type { Bookmark } from './types';
import { dispatchEvent, testWebhook, WEBHOOK_EVENTS, WEBHOOK_METHODS, type Webhook, type WebhookEvent } from './webhooks';
import {
  authenticatePasskey, authenticationOptions, deletePasskey, listPasskeys, PasskeyError, registerPasskey, registrationOptions,
} from './passkeys';
import { countSessions, createSession, destroyOtherSessions, destroySession, readSession, renewSession } from './session';
import { findShared, publicBookmark, thumbnailResponse, viewPage } from './share';

/** sessionId：以 Session Cookie 登入時才有，Basic Auth 呼叫沒有。appCredential：以應用程式帳密呼叫時才有 */
type AppEnv = { Bindings: Env; Variables: { sessionId?: string; appCredential?: AppCredential } };
type AppContext = Context<AppEnv>;

const app = new Hono<AppEnv>();

class BadRequest extends Error {}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseId(c: AppContext): number {
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequest('id 不正確');
  return id;
}

async function readJson(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // 落到下方的錯誤
  }
  throw new BadRequest('請求內容必須是 JSON 物件');
}

function emit(c: AppContext, event: WebhookEvent, bookmark: Bookmark) {
  c.executionCtx.waitUntil(
    dispatchEvent(c.env.DB, event, bookmark).catch((err) => console.error(JSON.stringify({ message: 'webhook dispatch failed', event, error: String(err) }))),
  );
}

function notifyCreated(c: AppContext, bookmark: Bookmark) {
  c.executionCtx.waitUntil(
    sendBookmarkMail(c.env, bookmark, new URL(c.req.url).origin)
      .then((results) => results.forEach((r) => console.log(JSON.stringify({ message: 'mail', bookmark: bookmark.id, to: r.to, status: r.status }))))
      .catch((err) => console.error(JSON.stringify({ message: 'mail failed', bookmark: bookmark.id, error: String(err) }))),
  );
}

// 測試用：最新一筆書籤，沒有就用範例資料
async function latestOrSample(db: D1Database): Promise<Bookmark> {
  const latest = (await listBookmarks(db, { limit: 1, offset: 0 })).items[0];
  if (latest) return latest;
  const now = new Date().toISOString();
  return {
    id: 0, url: 'https://example.com/', title: '範例書籤', summary: '這是測試資料。', category: '測試', note: '', tags: ['測試'],
    thumbnail: '', favicon: '', site: 'example.com', host: 'example.com', extra: {}, click_count: 0, created_at: now, updated_at: now, last_clicked_at: null, share_id: '',
  };
}

app.use('*', async (c, next) => {
  await next();
  c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
});

// PWA 需要的靜態檔不含資料，開放免登入：瀏覽器抓 manifest 與圖示時預設不帶認證，擋住會無法安裝。登入頁與其腳本同樣免登入
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/sw.js', '/offline.html', '/favicon.svg', '/app.css', '/app.js', '/login', '/login.js', '/passkey.js', '/view.css', '/view.js']);
// 書籤中轉頁與它的 API 免登入，網址裡的 share_id 不可猜；是否登入由路由自己讀 Session 判斷
const SHARE_PATH = /^\/(b|api\/share)\/[^/]+(\/thumbnail)?$/;
// 登入頁呼叫的 API（POST），尚未登入也要能用
const AUTH_PATHS = new Set(['/api/auth/login', '/api/auth/passkey/options', '/api/auth/passkey', '/api/auth/logout']);

// 整站需登入。瀏覽器在登入頁以密碼或 Passkey 換 Session Cookie；程式呼叫（捷徑、curl）照舊帶 Basic Auth。
// 帳密只由 AUTH_USER／AUTH_PASS 設定；沒設定時拒絕所有請求，不預設開放
app.use('*', async (c, next) => {
  if (c.req.method === 'GET' && (PUBLIC_PATHS.has(c.req.path) || c.req.path.startsWith('/icons/'))) return next();
  if (c.req.method === 'POST' && AUTH_PATHS.has(c.req.path)) return next();
  if (c.req.method === 'GET' && SHARE_PATH.test(c.req.path)) return next();

  const session = await readSession(c);
  if (session) {
    c.set('sessionId', session.id);
    await next();
    if (session.renew) await renewSession(c, session);
    return;
  }

  const creds = await loadCredentials(c.env);
  if (!creds) return c.text('尚未設定 AUTH_PASS，請以 wrangler secret put AUTH_PASS 設定登入密碼。', 503);
  const auth = basicAuth({ realm: 'Bookmark Shelf', verifyUser: (username, password) => verifyBasic(c, creds, username, password) });
  if (c.req.header('Authorization')) return auth(c, next);
  // 瀏覽器（帶 Sec-Fetch-Mode）不回 Basic Auth 的 401 挑戰，否則會跳出瀏覽器內建的登入框；頁面導向登入頁，登入後回到原網址
  const mode = c.req.header('Sec-Fetch-Mode');
  if (mode === 'navigate') return c.redirect(`/login?next=${encodeURIComponent(c.req.path + new URL(c.req.url).search)}`, 302);
  if (mode) return c.json({ error: '尚未登入或登入已過期' }, 401);
  return auth(c, next);
});

// Basic Auth 先比對 AUTH_USER／AUTH_PASS，不符再查應用程式帳密
async function verifyBasic(c: AppContext, creds: Credentials, username: string, password: string): Promise<boolean> {
  if (await checkCredentials(creds, username, password)) return true;
  const credential = await verifyAppCredential(c.env.DB, username, password);
  if (credential) c.set('appCredential', credential);
  return Boolean(credential);
}

// 應用程式帳密只能呼叫書籤 API，不能改設定、新增帳密或 Passkey
const APP_PATH = /^\/api\/(bookmarks(\/[^/]+)?|preview)$/;

// 每次呼叫都記一筆（含被擋下的 403），回應送出後才在背景寫入
app.use('*', async (c, next) => {
  const credential = c.get('appCredential');
  if (!credential) return next();
  const started = Date.now();
  if (!APP_PATH.test(c.req.path)) {
    const res = c.json({ error: '應用程式帳密只能呼叫 /api/bookmarks 與 /api/preview' }, 403);
    logAppCall(c, credential, res, started);
    return res;
  }
  await next();
  logAppCall(c, credential, c.res, started);
});

function logAppCall(c: AppContext, credential: AppCredential, res: Response, started: number) {
  const url = new URL(c.req.url);
  const pathId = c.req.path.match(/^\/api\/bookmarks\/(\d+)$/)?.[1];
  // 新增書籤的 id 只在回應裡（重複網址的 409 也帶 id），要在回應送出前複製一份
  const created = c.req.method === 'POST' && c.req.path === '/api/bookmarks' ? res.clone() : null;
  const entry = {
    method: c.req.method,
    path: (url.pathname + url.search).slice(0, 500),
    status: res.status,
    ip: c.req.header('CF-Connecting-IP') ?? '',
    user_agent: (c.req.header('User-Agent') ?? '').slice(0, 300),
    duration_ms: Date.now() - started,
  };
  c.executionCtx.waitUntil(
    (async () => {
      const body = created ? ((await created.json().catch(() => ({}))) as { bookmark?: { id?: number }; id?: number }) : {};
      const bookmarkId = pathId ? Number(pathId) : (body.bookmark?.id ?? body.id ?? null);
      await Promise.all([recordAppLog(c.env.DB, credential, { ...entry, bookmark_id: bookmarkId }), touchAppCredential(c.env.DB, credential)]);
    })().catch((err) => console.error(JSON.stringify({ message: 'app log failed', app: credential.id, error: String(err) }))),
  );
}

// 瀏覽器會自動帶 Basic Auth，寫入 API 需擋跨站請求：同源檢查＋強制 JSON（跨站表單送不出 JSON）
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: '不允許跨站請求' }, 403);
  if (['POST', 'PATCH', 'PUT'].includes(c.req.method) && !(c.req.header('Content-Type') ?? '').includes('application/json')) {
    return c.json({ error: 'Content-Type 必須是 application/json' }, 415);
  }
  return next();
});

app.get('/api/meta', (c) =>
  c.json({
    ai: aiEnabled(c.env),
    extractors: EXTRACTORS.map((e) => e.name),
    events: WEBHOOK_EVENTS,
    methods: WEBHOOK_METHODS,
  }),
);

app.post('/api/preview', async (c) => {
  const body = await readJson(c);
  const draft = await buildDraft(c.env, text(body.url, 2048));
  return c.json({ draft, duplicateId: await findIdByUrl(c.env.DB, draft.url) });
});

app.get('/api/overview', async (c) => c.json(await getOverview(c.env.DB)));

app.get('/api/bookmarks', async (c) => {
  const q = c.req.query();
  const limit = Math.min(Math.max(Number(q.limit) || 24, 1), 100);
  const offset = Math.max(Number(q.offset) || 0, 0);
  return c.json(await listBookmarks(c.env.DB, { q: q.q, site: q.site, tag: q.tag, category: q.category, sort: q.sort, limit, offset }));
});

// 只給 url 時自動抓取並產生內容（方便捷徑、外部程式直接呼叫）；有 title 時以傳入的欄位為準
app.post('/api/bookmarks', async (c) => {
  const body = await readJson(c);
  const url = normalizeUrl(text(body.url, 2048));
  const existing = await findIdByUrl(c.env.DB, url);
  if (existing) return c.json({ error: '這個網址已經收藏過了', id: existing }, 409);

  const target = new URL(url);
  const draft = typeof body.title === 'string' && body.title.trim() ? null : await buildDraft(c.env, url);
  const extra = body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra) ? (body.extra as Record<string, unknown>) : {};
  const bookmark = await insertBookmark(c.env.DB, {
    url,
    title: draft?.title ?? text(body.title, 300),
    summary: draft?.summary ?? text(body.summary, 2000),
    category: draft?.category ?? text(body.category, 40),
    tags: draft?.tags ?? normalizeTags(body.tags),
    note: text(body.note, 5000),
    thumbnail: draft?.thumbnail ?? safeUrl(text(body.thumbnail, 2048)),
    favicon: draft?.favicon ?? safeUrl(text(body.favicon, 2048)),
    site: siteOf(target),
    host: hostOf(target),
    extra: draft?.extra ?? extra,
  });
  emit(c, 'bookmark.created', bookmark);
  notifyCreated(c, bookmark);
  return c.json({ bookmark }, 201);
});

app.get('/api/bookmarks/:id', async (c) => {
  const bookmark = await getBookmark(c.env.DB, parseId(c));
  return bookmark ? c.json({ bookmark }) : c.json({ error: '找不到書籤' }, 404);
});

app.patch('/api/bookmarks/:id', async (c) => {
  const id = parseId(c);
  const body = await readJson(c);
  const limits = { title: 300, summary: 2000, category: 40, note: 5000, thumbnail: 2048 } as const;
  const patch: BookmarkPatch = {};
  for (const [key, max] of Object.entries(limits) as [keyof typeof limits, number][]) {
    if (body[key] !== undefined) patch[key] = text(body[key], max);
  }
  if (patch.thumbnail) patch.thumbnail = safeUrl(patch.thumbnail);
  if (body.tags !== undefined) patch.tags = normalizeTags(body.tags);
  if (!(await getBookmark(c.env.DB, id))) return c.json({ error: '找不到書籤' }, 404);
  const bookmark = (await updateBookmark(c.env.DB, id, patch))!;
  emit(c, 'bookmark.updated', bookmark);
  return c.json({ bookmark });
});

app.delete('/api/bookmarks/:id', async (c) => {
  const id = parseId(c);
  const bookmark = await getBookmark(c.env.DB, id);
  if (!bookmark) return c.json({ error: '找不到書籤' }, 404);
  await deleteBookmark(c.env.DB, id);
  emit(c, 'bookmark.deleted', bookmark);
  return c.json({ ok: true });
});

// 書籤中轉頁：列表點開書籤先到這裡，未登入也能瀏覽（auth middleware 以 SHARE_PATH 放行）
app.get('/b/:shareId', async (c) => {
  const page = await c.env.ASSETS.fetch(new URL('/view', c.req.url));
  const url = new URL(c.req.url);
  return viewPage(page, await findShared(c.env.DB, c.req.param('shareId')), url.origin + url.pathname);
});

// 未登入只回公開欄位；登入時回完整書籤與登入名稱，頁面才顯示編輯與返回
app.get('/api/share/:shareId', async (c) => {
  const bookmark = await findShared(c.env.DB, c.req.param('shareId'));
  if (!bookmark) return c.json({ error: '找不到這筆書籤，可能已被刪除' }, 404);
  if (!(await readSession(c))) return c.json({ bookmark: publicBookmark(bookmark), owner: false });
  const [settings, creds] = await Promise.all([getSettings(c.env.DB, ['profile_name']), loadCredentials(c.env)]);
  return c.json({ bookmark, owner: true, viewer: { name: settings.profile_name || creds?.username || '' } });
});

app.get('/api/share/:shareId/thumbnail', async (c) => {
  const bookmark = await findShared(c.env.DB, c.req.param('shareId'));
  return bookmark ? thumbnailResponse(bookmark) : c.text('找不到書籤', 404);
});

// 列表上的連結都經過這裡，用來記錄最近點擊
app.get('/go/:id', async (c) => {
  const id = parseId(c);
  const url = await recordClick(c.env.DB, id);
  if (!url) return c.text('找不到書籤', 404);
  c.executionCtx.waitUntil(
    getBookmark(c.env.DB, id).then((bookmark) => (bookmark ? dispatchEvent(c.env.DB, 'bookmark.clicked', bookmark) : undefined)).catch((err) => console.error(String(err))),
  );
  return c.redirect(url, 302);
});

function parseWebhook(body: Record<string, unknown>, partial: boolean) {
  const hook: Partial<Pick<Webhook, 'name' | 'event' | 'url' | 'method' | 'secret' | 'enabled'>> = {};
  if (body.name !== undefined) hook.name = text(body.name, 80);
  if (body.event !== undefined || !partial) {
    const event = text(body.event, 40);
    if (event !== '*' && !(WEBHOOK_EVENTS as readonly string[]).includes(event)) throw new BadRequest('事件不正確');
    hook.event = event;
  }
  if (body.url !== undefined || !partial) {
    const url = safeUrl(text(body.url, 2048));
    if (!url) throw new BadRequest('Webhook 網址必須是 http 或 https');
    hook.url = url;
  }
  if (body.method !== undefined || !partial) {
    const method = text(body.method, 20) || 'POST_JSON';
    if (!(WEBHOOK_METHODS as readonly string[]).includes(method)) throw new BadRequest('呼叫方式不正確');
    hook.method = method as Webhook['method'];
  }
  if (body.secret !== undefined) hook.secret = text(body.secret, 200);
  if (body.enabled !== undefined) hook.enabled = body.enabled ? 1 : 0;
  return hook;
}

// 回傳給前端時不帶出 secret，只標示有沒有設定
function publicWebhook({ secret, ...hook }: Webhook) {
  return { ...hook, has_secret: Boolean(secret) };
}

app.get('/api/webhooks', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM webhooks ORDER BY id DESC').all<Webhook>();
  return c.json({ webhooks: results.map(publicWebhook) });
});

app.post('/api/webhooks', async (c) => {
  const hook = parseWebhook(await readJson(c), false);
  const row = await c.env.DB.prepare(
    'INSERT INTO webhooks (name, event, url, method, secret, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
  )
    .bind(hook.name ?? '', hook.event, hook.url, hook.method, hook.secret ?? '', hook.enabled ?? 1, new Date().toISOString())
    .first<Webhook>();
  return c.json({ webhook: publicWebhook(row!) }, 201);
});

app.patch('/api/webhooks/:id', async (c) => {
  const id = parseId(c);
  const hook = parseWebhook(await readJson(c), true);
  const keys = Object.keys(hook) as (keyof typeof hook)[];
  if (!keys.length) throw new BadRequest('沒有要更新的欄位');
  const row = await c.env.DB.prepare(`UPDATE webhooks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? RETURNING *`)
    .bind(...keys.map((k) => hook[k]), id)
    .first<Webhook>();
  return row ? c.json({ webhook: publicWebhook(row) }) : c.json({ error: '找不到 webhook' }, 404);
});

app.delete('/api/webhooks/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM webhooks WHERE id = ?').bind(parseId(c)).run();
  return c.json({ ok: true });
});

// 用最新一筆書籤（沒有就用範例資料）實際呼叫一次
app.post('/api/webhooks/:id/test', async (c) => {
  const hook = await c.env.DB.prepare('SELECT * FROM webhooks WHERE id = ?').bind(parseId(c)).first<Webhook>();
  if (!hook) return c.json({ error: '找不到 webhook' }, 404);
  return c.json({ status: await testWebhook(c.env.DB, hook, await latestOrSample(c.env.DB)) });
});

// 設定頁：姓名與偏好。登入帳號只顯示，帳密由環境變數 AUTH_USER／AUTH_PASS 設定
async function loadProfile(env: Env) {
  const [settings, creds] = await Promise.all([getSettings(env.DB, ['profile_name', 'auto_save']), loadCredentials(env)]);
  return { name: settings.profile_name ?? '', autoSave: settings.auto_save === '1', username: creds?.username ?? '' };
}

app.get('/api/settings', async (c) => c.json(await loadProfile(c.env)));

// 只更新有傳的欄位。autoSave：新增書籤時抓取完直接保存，不顯示確認表單
app.patch('/api/settings', async (c) => {
  const body = await readJson(c);
  const entries: Record<string, string> = {};
  if (body.name !== undefined) entries.profile_name = text(body.name, 40);
  if (body.autoSave !== undefined) entries.auto_save = body.autoSave ? '1' : '0';
  if (!Object.keys(entries).length) throw new BadRequest('沒有要更新的欄位');
  await putSettings(c.env.DB, entries);
  return c.json(await loadProfile(c.env));
});

// 新增書籤通知信：寄件地址與收件地址。收件地址需先在 Cloudflare Email Routing 驗證
app.get('/api/settings/mail', async (c) => c.json(await loadMailSettings(c.env.DB)));

app.put('/api/settings/mail', async (c) => {
  const body = await readJson(c);
  const from = text(body.from, 254).toLowerCase();
  const list = Array.isArray(body.to) ? body.to : typeof body.to === 'string' ? body.to.split(/[\s,;，、]+/) : [];
  const to = [...new Set(list.map((item) => text(item, 254).toLowerCase()).filter(Boolean))];
  if (from && !isEmail(from)) throw new BadRequest('寄件地址格式不正確');
  const invalid = to.filter((item) => !isEmail(item));
  if (invalid.length) throw new BadRequest(`收件地址格式不正確：${invalid.join('、')}`);
  if (to.length > MAX_RECIPIENTS) throw new BadRequest(`收件地址最多 ${MAX_RECIPIENTS} 個`);
  if (to.length && !from) throw new BadRequest('有收件地址時必須填寫寄件地址');
  await saveMailSettings(c.env.DB, { from, to });
  return c.json({ from, to });
});

// 用最新一筆書籤寄一次，回傳每個收件地址的結果
app.post('/api/settings/mail/test', async (c) => {
  const mail = await loadMailSettings(c.env.DB);
  if (!mail.from || !mail.to.length) throw new BadRequest('請先儲存寄件地址與收件地址');
  const results = await sendBookmarkMail(c.env, await latestOrSample(c.env.DB), new URL(c.req.url).origin, true);
  return c.json({ results });
});

function passkeyResponse<T>(body: Record<string, unknown>): T {
  const response = body.response as { id?: unknown } | undefined;
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') throw new BadRequest('缺少 Passkey 回應');
  return response as T;
}

// 登入頁：密碼或 Passkey 換 Session Cookie（30 天，使用中自動延長）
app.post('/api/auth/login', async (c) => {
  const body = await readJson(c);
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const creds = await loadCredentials(c.env);
  if (!creds) return c.json({ error: '尚未設定 AUTH_PASS' }, 503);
  if (!(await checkCredentials(creds, username, password))) return c.json({ error: '帳號或密碼不正確' }, 401);
  await createSession(c, 'password');
  return c.json({ ok: true });
});

app.post('/api/auth/passkey/options', async (c) => c.json(await authenticationOptions(c.env.DB, c.req.url)));

app.post('/api/auth/passkey', async (c) => {
  await authenticatePasskey(c.env.DB, c.req.url, passkeyResponse(await readJson(c)));
  await createSession(c, 'passkey');
  return c.json({ ok: true });
});

app.post('/api/auth/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

// 設定頁：Passkey 與登入中的裝置
app.get('/api/settings/login', async (c) => {
  const [passkeys, sessions] = await Promise.all([listPasskeys(c.env.DB), countSessions(c.env.DB)]);
  return c.json({ passkeys, sessions, session: Boolean(c.get('sessionId')) });
});

// 新增 Passkey 等於多一種登入方式，要再輸入目前密碼
app.post('/api/settings/passkeys/options', async (c) => {
  const body = await readJson(c);
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const creds = await loadCredentials(c.env);
  if (!creds || !(await checkCredentials(creds, creds.username, current))) return c.json({ error: '目前密碼不正確' }, 403);
  return c.json(await registrationOptions(c.env.DB, c.req.url, creds.username));
});

app.post('/api/settings/passkeys', async (c) => {
  const body = await readJson(c);
  await registerPasskey(c.env.DB, c.req.url, passkeyResponse(body), text(body.name, 60));
  return c.json({ passkeys: await listPasskeys(c.env.DB) }, 201);
});

app.delete('/api/settings/passkeys/:id', async (c) => {
  if (!(await deletePasskey(c.env.DB, c.req.param('id')))) return c.json({ error: '找不到這個 Passkey' }, 404);
  return c.json({ passkeys: await listPasskeys(c.env.DB) });
});

app.delete('/api/settings/sessions', async (c) => {
  await destroyOtherSessions(c.env.DB, c.get('sessionId'));
  return c.json({ sessions: await countSessions(c.env.DB) });
});

// 設定頁：應用程式帳密。建立時才回傳一次原始密碼
app.get('/api/settings/apps', async (c) => c.json({ apps: await listAppCredentials(c.env.DB) }));

// 跟新增 Passkey 一樣是多一種登入方式，要再輸入目前密碼；已有 Passkey 時可改帶 Passkey 的驗證回應（選項由 /api/auth/passkey/options 取得）
app.post('/api/settings/apps', async (c) => {
  const body = await readJson(c);
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const creds = await loadCredentials(c.env);
  if (body.passkey) await authenticatePasskey(c.env.DB, c.req.url, passkeyResponse({ response: body.passkey }));
  else if (!creds || !(await checkCredentials(creds, creds.username, current))) return c.json({ error: '目前密碼不正確' }, 403);
  const name = text(body.name, 60);
  if (!name) throw new BadRequest('請填寫名稱');
  if ((await countAppCredentials(c.env.DB)) >= MAX_APP_CREDENTIALS) throw new BadRequest(`應用程式帳密最多 ${MAX_APP_CREDENTIALS} 組`);
  const { credential, password } = await createAppCredential(c.env.DB, name, { ...LOG_DEFAULTS, ...parseRetention(body) });
  return c.json({ app: credential, password, apps: await listAppCredentials(c.env.DB) }, 201);
});

app.delete('/api/settings/apps/:id', async (c) => {
  if (!(await deleteAppCredential(c.env.DB, parseId(c)))) return c.json({ error: '找不到這組應用程式帳密' }, 404);
  return c.json({ apps: await listAppCredentials(c.env.DB) });
});

// 呼叫紀錄的保留天數與筆數：預設 7 天、700 筆，上限 30 天、10000 筆
const RETENTION_FIELDS = { logDays: ['log_days', '保留天數'], logLimit: ['log_limit', '保留筆數'] } as const;

function parseRetention(body: Record<string, unknown>): Partial<LogRetention> {
  const retention: Partial<LogRetention> = {};
  for (const [field, [key, label]] of Object.entries(RETENTION_FIELDS)) {
    if (body[field] === undefined || body[field] === '') continue;
    const value = Number(body[field]);
    if (!Number.isInteger(value) || value < 1 || value > LOG_MAX[key]) throw new BadRequest(`${label}必須是 1 到 ${LOG_MAX[key]} 的整數`);
    retention[key] = value;
  }
  return retention;
}

// 改名稱或保留條件；縮短保留條件時，超出的紀錄立即刪除
app.patch('/api/settings/apps/:id', async (c) => {
  const id = parseId(c);
  const body = await readJson(c);
  const patch: Partial<Pick<AppCredential, 'name' | 'log_days' | 'log_limit'>> = parseRetention(body);
  if (body.name !== undefined) {
    patch.name = text(body.name, 60);
    if (!patch.name) throw new BadRequest('請填寫名稱');
  }
  if (!Object.keys(patch).length) throw new BadRequest('沒有要更新的欄位');
  const credential = await updateAppCredential(c.env.DB, id, patch);
  if (!credential) return c.json({ error: '找不到這組應用程式帳密' }, 404);
  return c.json({ app: credential, apps: await listAppCredentials(c.env.DB) });
});

app.get('/api/settings/apps/:id/logs', async (c) => {
  const q = c.req.query();
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  return c.json(await listAppLogs(c.env.DB, parseId(c), limit, offset));
});

app.all('/api/*', (c) => c.json({ error: '找不到這個 API' }, 404));

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  if (err instanceof BadRequest || err instanceof CrawlError || err instanceof PasskeyError) return c.json({ error: err.message }, 400);
  // basicAuth 的 401 等 HTTPException 帶有自己的回應
  if (err instanceof HTTPException) return err.getResponse();
  // 同一網址同時送出兩次，第二筆撞到 UNIQUE
  if (err.message.includes('UNIQUE constraint failed: bookmarks.url')) return c.json({ error: '這個網址已經收藏過了' }, 409);
  console.error(JSON.stringify({ message: 'unhandled error', path: c.req.path, error: err.message, stack: err.stack }));
  return c.json({ error: '伺服器錯誤，請稍後再試' }, 500);
});

export default app;
