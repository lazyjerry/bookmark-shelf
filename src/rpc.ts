// 給同帳號其他 Worker（MCP 閘道）用的 RPC 入口。只開放書籤資料操作，不開放設定、帳密、Passkey、寄信設定
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createBookmark, editBookmark, rateLimited, removeBookmark, text, type Caller, type MutationResult } from './bookmarks';
import { CrawlError } from './crawler';
import { findIdByUrl, getBookmark, getOverview, listBookmarks } from './db';
import { buildDraft } from './enrich';
import { RateLimitError } from './ratelimit';
import type { Bookmark } from './types';

export interface SearchParams {
  q?: string;
  site?: string;
  tag?: string;
  category?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

// 選用：通知信裡「開啟書籤收藏櫃」的網址。REST 取自請求網址，RPC 沒有請求網址，改讀這個變數
declare global {
  interface Env {
    APP_URL?: string;
  }
}

export interface BookmarkFields {
  url: string;
  title?: string;
  summary?: string;
  category?: string;
  tags?: string[] | string;
  note?: string;
}

export type BookmarkChanges = Partial<Omit<BookmarkFields, 'url'>>;

// share_id 拿到就能免登入看中轉頁，RPC 一律不回傳
export type RpcBookmark = Omit<Bookmark, 'share_id'>;

function strip({ share_id, ...bookmark }: Bookmark): RpcBookmark {
  return bookmark;
}

function stripResult(result: MutationResult) {
  return result.ok ? { ok: true as const, bookmark: strip(result.bookmark) } : result;
}

/** 寫入類操作記一筆 Workers Logs：呼叫者、操作、影響的書籤 id、結果。不記請求內容 */
function logCall(op: string, caller: Caller | undefined, id: number | null, result: MutationResult) {
  const bookmark = result.ok ? result.bookmark.id : result.reason === 'duplicate' ? result.id : id;
  console.log(JSON.stringify({ message: 'rpc', op, client: caller?.client ?? '', bookmark, result: result.ok ? 'ok' : result.reason }));
}

// 與 REST 的 parseId 同一條規則。RPC 參數來自別的 Worker，型別不保證：'3' 這類值不可被資料庫當成 3
function validId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

const INVALID_ID = { ok: false as const, reason: 'invalid' as const, message: 'id 不正確' };

export class BookmarkRpc extends WorkerEntrypoint<Env> {
  /** 與 GET /api/bookmarks 相同：limit 預設 24、上限 100 */
  async search(params: SearchParams = {}) {
    const limit = Math.min(Math.max(Number(params.limit) || 24, 1), 100);
    const offset = Math.max(Number(params.offset) || 0, 0);
    const { items, hasMore } = await listBookmarks(this.env.DB, { q: params.q, site: params.site, tag: params.tag, category: params.category, sort: params.sort, limit, offset });
    return { items: items.map(strip), hasMore };
  }

  async get(id: number) {
    if (!validId(id)) return null;
    const bookmark = await getBookmark(this.env.DB, id);
    return bookmark ? strip(bookmark) : null;
  }

  /** 分類、標籤、網站清單與最近的書籤 */
  async overview() {
    const overview = await getOverview(this.env.DB);
    return { ...overview, recent: overview.recent.map(strip), clicked: overview.clicked.map(strip) };
  }

  /** 抓取網頁產生草稿，不寫入。會連外並可能使用 Workers AI；網址不正確、超過速率限制以回傳值表達 */
  async preview(url: string) {
    try {
      const draft = await buildDraft(this.env, text(url, 2048));
      return { ok: true as const, draft, duplicateId: await findIdByUrl(this.env.DB, draft.url) };
    } catch (err) {
      if (err instanceof CrawlError) return { ok: false as const, reason: 'invalid' as const, message: err.message };
      if (err instanceof RateLimitError) return rateLimited(err);
      throw err;
    }
  }

  /** 只給 url 時自動抓取並產生內容；帶 title 時以傳入的欄位為準 */
  async add(input: BookmarkFields, caller: Caller) {
    // 只取契約內的欄位：extra、thumbnail、favicon 是 REST 才收的，RPC 呼叫者多帶也不採用
    const { url, title, summary, category, tags, note } = input ?? ({} as BookmarkFields);
    const result = await createBookmark(this.env, this.ctx, { url, title, summary, category, tags, note }, this.env.APP_URL ?? '');
    logCall('add', caller, null, result);
    return stripResult(result);
  }

  async update(id: number, patch: BookmarkChanges, caller: Caller) {
    if (!validId(id)) return INVALID_ID;
    // 只取契約內的欄位，理由同 add
    const { title, summary, category, tags, note } = patch ?? {};
    const result = await editBookmark(this.env, this.ctx, id, { title, summary, category, tags, note });
    logCall('update', caller, id, result);
    return stripResult(result);
  }

  async remove(id: number, caller: Caller) {
    if (!validId(id)) return INVALID_ID;
    const result = await removeBookmark(this.env, this.ctx, id);
    logCall('remove', caller, id, result);
    return stripResult(result);
  }
}
