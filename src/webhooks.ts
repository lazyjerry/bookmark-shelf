import type { Bookmark } from './types';

export const WEBHOOK_EVENTS = ['bookmark.created', 'bookmark.updated', 'bookmark.deleted', 'bookmark.clicked'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_METHODS = ['GET', 'POST_JSON', 'POST_FORM'] as const;
export type WebhookMethod = (typeof WEBHOOK_METHODS)[number];

export interface Webhook {
  id: number;
  name: string;
  /** 事件名稱，或 * 代表全部事件 */
  event: string;
  url: string;
  method: WebhookMethod;
  secret: string;
  enabled: number;
  last_status: string;
  last_called_at: string | null;
  created_at: string;
}

export interface WebhookPayload {
  event: WebhookEvent | 'webhook.test';
  timestamp: string;
  bookmark: Bookmark;
}

const TIMEOUT_MS = 8_000;

/** GET 與表單用的扁平欄位：標籤以逗號串接，extra 以 JSON 字串 */
function flatten(payload: WebhookPayload): Record<string, string> {
  const b = payload.bookmark;
  return {
    event: payload.event,
    timestamp: payload.timestamp,
    id: String(b.id),
    url: b.url,
    title: b.title,
    summary: b.summary,
    category: b.category,
    tags: b.tags.join(','),
    note: b.note,
    site: b.site,
    thumbnail: b.thumbnail,
    click_count: String(b.click_count),
    created_at: b.created_at,
    extra: JSON.stringify(b.extra),
  };
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 呼叫單一 webhook，回傳寫進 last_status 的結果字串 */
export async function callWebhook(hook: Webhook, payload: WebhookPayload): Promise<string> {
  const headers: Record<string, string> = { 'User-Agent': 'BookmarkShelf-Webhook/1.0', 'X-Bookmark-Event': payload.event };
  let target = hook.url;
  let body: string | undefined;
  let signed = '';

  if (hook.method === 'GET') {
    const url = new URL(hook.url);
    for (const [key, value] of Object.entries(flatten(payload))) url.searchParams.set(key, value);
    target = url.toString();
    signed = url.search.slice(1);
  } else if (hook.method === 'POST_FORM') {
    body = new URLSearchParams(flatten(payload)).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    signed = body;
  } else {
    body = JSON.stringify(payload);
    headers['Content-Type'] = 'application/json';
    signed = body;
  }
  if (hook.secret) headers['X-Bookmark-Signature'] = await sign(hook.secret, signed);

  try {
    const res = await fetch(target, {
      method: hook.method === 'GET' ? 'GET' : 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    return `HTTP ${res.status}`;
  } catch (err) {
    return `ERROR ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function recordStatus(db: D1Database, id: number, status: string): Promise<void> {
  await db.prepare('UPDATE webhooks SET last_status = ?, last_called_at = ? WHERE id = ?').bind(status, new Date().toISOString(), id).run();
}

/** 找出訂閱該事件的 webhook 全部呼叫一次。交給 ctx.waitUntil 執行，不擋使用者的請求 */
export async function dispatchEvent(db: D1Database, event: WebhookEvent, bookmark: Bookmark): Promise<void> {
  const { results } = await db
    .prepare(`SELECT * FROM webhooks WHERE enabled = 1 AND (event = ? OR event = '*')`)
    .bind(event)
    .all<Webhook>();
  const payload: WebhookPayload = { event, timestamp: new Date().toISOString(), bookmark };
  await Promise.all(
    results.map(async (hook) => {
      const status = await callWebhook(hook, payload);
      await recordStatus(db, hook.id, status);
      console.log(JSON.stringify({ message: 'webhook', event, webhook: hook.id, status }));
    }),
  );
}

export async function testWebhook(db: D1Database, hook: Webhook, bookmark: Bookmark): Promise<string> {
  const status = await callWebhook(hook, { event: 'webhook.test', timestamp: new Date().toISOString(), bookmark });
  await recordStatus(db, hook.id, status);
  return status;
}
