// 書籤的新增、更新、刪除流程，REST handler 與 BookmarkRpc 共用：驗證規則、webhook、通知信只寫在這裡
import { CrawlError, normalizeUrl, safeUrl } from './crawler';
import { deleteBookmark, findIdByUrl, getBookmark, insertBookmark, normalizeTags, updateBookmark, type BookmarkPatch } from './db';
import { buildDraft } from './enrich';
import { sendBookmarkMail } from './mailer';
import { hostOf, siteOf } from './sites';
import type { Bookmark } from './types';
import { dispatchEvent, type WebhookEvent } from './webhooks';

/** 背景工作只需要 waitUntil：Hono 的 executionCtx 與 WorkerEntrypoint 的 ctx 都有 */
export interface Background {
  waitUntil(promise: Promise<unknown>): void;
}

/** 經 RPC 呼叫時由閘道傳入的呼叫者（OAuth client），只寫進 Workers Logs */
export interface Caller {
  client: string;
}

export type MutationResult =
  | { ok: true; bookmark: Bookmark }
  | { ok: false; reason: 'duplicate'; id: number }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'not_found' };

export function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function emit(env: Env, bg: Background, event: WebhookEvent, bookmark: Bookmark) {
  bg.waitUntil(
    dispatchEvent(env.DB, event, bookmark).catch((err) => console.error(JSON.stringify({ message: 'webhook dispatch failed', event, error: String(err) }))),
  );
}

function notifyCreated(env: Env, bg: Background, bookmark: Bookmark, appUrl: string) {
  bg.waitUntil(
    sendBookmarkMail(env, bookmark, appUrl)
      .then((results) => results.forEach((r) => console.log(JSON.stringify({ message: 'mail', bookmark: bookmark.id, to: r.to, status: r.status }))))
      .catch((err) => console.error(JSON.stringify({ message: 'mail failed', bookmark: bookmark.id, error: String(err) }))),
  );
}

/** 只給 url 時自動抓取並產生內容；有 title 時以傳入的欄位為準。appUrl 是通知信裡「開啟書籤收藏櫃」的網址 */
export async function createBookmark(env: Env, bg: Background, body: Record<string, unknown>, appUrl: string): Promise<MutationResult> {
  let url: string;
  try {
    url = normalizeUrl(text(body.url, 2048));
  } catch (err) {
    if (err instanceof CrawlError) return { ok: false, reason: 'invalid', message: err.message };
    throw err;
  }
  const existing = await findIdByUrl(env.DB, url);
  if (existing) return { ok: false, reason: 'duplicate', id: existing };

  const target = new URL(url);
  const draft = typeof body.title === 'string' && body.title.trim() ? null : await buildDraft(env, url);
  const extra = body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra) ? (body.extra as Record<string, unknown>) : {};
  const bookmark = await insertBookmark(env.DB, {
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
  emit(env, bg, 'bookmark.created', bookmark);
  notifyCreated(env, bg, bookmark, appUrl);
  return { ok: true, bookmark };
}

/** 只更新有傳的欄位；url 不可改 */
export async function editBookmark(env: Env, bg: Background, id: number, body: Record<string, unknown>): Promise<MutationResult> {
  const limits = { title: 300, summary: 2000, category: 40, note: 5000, thumbnail: 2048 } as const;
  const patch: BookmarkPatch = {};
  for (const [key, max] of Object.entries(limits) as [keyof typeof limits, number][]) {
    if (body[key] !== undefined) patch[key] = text(body[key], max);
  }
  if (patch.thumbnail) patch.thumbnail = safeUrl(patch.thumbnail);
  if (body.tags !== undefined) patch.tags = normalizeTags(body.tags);
  if (!(await getBookmark(env.DB, id))) return { ok: false, reason: 'not_found' };
  const bookmark = (await updateBookmark(env.DB, id, patch))!;
  emit(env, bg, 'bookmark.updated', bookmark);
  return { ok: true, bookmark };
}

export async function removeBookmark(env: Env, bg: Background, id: number): Promise<MutationResult> {
  const bookmark = await getBookmark(env.DB, id);
  if (!bookmark) return { ok: false, reason: 'not_found' };
  await deleteBookmark(env.DB, id);
  emit(env, bg, 'bookmark.deleted', bookmark);
  return { ok: true, bookmark };
}
