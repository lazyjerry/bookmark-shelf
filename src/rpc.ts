// 給同帳號其他 Worker（MCP 閘道）用的 RPC 入口。只開放書籤資料操作，不開放設定、帳密、Passkey、寄信設定
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createBookmark, type Background, type Caller, type MutationResult } from './bookmarks';
import { getBookmark, getOverview, listBookmarks } from './db';
import { callTool, describeService, type ToolOps } from './tools';
import type { Bookmark } from './types';

// 選用：通知信裡「開啟書籤收藏櫃」的網址。REST 取自請求網址，RPC 沒有請求網址，改讀這個變數
declare global {
  interface Env {
    APP_URL?: string;
  }
}

// share_id 拿到就能免登入看中轉頁，RPC 一律不回傳
function strip({ share_id, ...bookmark }: Bookmark): Omit<Bookmark, 'share_id'> {
  return bookmark;
}

/** 寫入類操作記一筆 Workers Logs：呼叫者、操作、影響的書籤 id、結果。不記請求內容 */
function logCall(op: string, caller: Caller | undefined, result: MutationResult) {
  const bookmark = result.ok ? result.bookmark.id : result.reason === 'duplicate' ? result.id : null;
  console.log(JSON.stringify({ message: 'rpc', op, client: caller?.client ?? '', bookmark, result: result.ok ? 'ok' : result.reason }));
}

/**
 * call() 執行 tool 時用的操作，參數已由 src/tools.ts 驗過。
 * 不放在 BookmarkRpc 上：類別上的方法都會開放成 RPC，呼叫者就能繞過 tool 的參數驗證與授權範圍
 */
function toolOps(env: Env, bg: Background): ToolOps {
  return {
    /** 與 GET /api/bookmarks 相同：limit 預設 24、上限 100 */
    async search(params) {
      const limit = Math.min(Math.max(Number(params.limit) || 24, 1), 100);
      const offset = Math.max(Number(params.offset) || 0, 0);
      const { items, hasMore } = await listBookmarks(env.DB, { q: params.q, site: params.site, tag: params.tag, category: params.category, limit, offset });
      return { items: items.map(strip), hasMore };
    },

    async get(id) {
      const bookmark = await getBookmark(env.DB, id);
      return bookmark ? strip(bookmark) : null;
    },

    /** 分類、標籤、網站清單與最近的書籤 */
    async overview() {
      const overview = await getOverview(env.DB);
      return { ...overview, recent: overview.recent.map(strip), clicked: overview.clicked.map(strip) };
    },

    async add(input, caller) {
      // 只取契約內的欄位：extra、thumbnail、favicon 是 REST 才收的
      const { url, title, summary, category, tags, note } = input;
      const result = await createBookmark(env, bg, { url, title, summary, category, tags, note }, env.APP_URL ?? '');
      logCall('add', caller, result);
      return result.ok ? { ok: true as const, bookmark: strip(result.bookmark) } : result;
    },
  };
}

export class BookmarkRpc extends WorkerEntrypoint<Env> {
  /** 服務自述：同意頁顯示的名稱、授權範圍、tool 清單（含 JSON Schema）。閘道不寫死這些，啟動後向每個服務要 */
  async describe() {
    return describeService();
  }

  /** 執行 describe() 列出的 tool。參數在這裡驗證，可預期的失敗回 { ok: false, message }，不丟例外 */
  async call(tool: string, args: unknown, caller: Caller) {
    return callTool(toolOps(this.env, this.ctx), tool, args, caller);
  }
}
