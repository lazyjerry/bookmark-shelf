# 02 服務綁定與 RPC

> 狀態：已實作。與下面範例的差異：RPC 另有 `overview`、`preview`、`update`、`remove`；共用流程是 `createBookmark(env, ctx, body, appUrl)`，`caller` 由 `BookmarkRpc` 寫進 Workers Logs，不進 D1；`preview` 回 `{ ok, draft, duplicateId }`；`get`、`search`、`overview` 不回 `share_id`；`preview`、`add`、`update`、`remove` 超過速率限制時回 `{ ok: false, reason: 'rate_limited', message, retryAfter }`；`add`、`update` 只取契約內的欄位，多帶的不採用；閘道只用 `search`、`get`、`overview`、`add`，`preview`、`update`、`remove` 還留在 RPC 上，等閘道部署後再移除，原因見 [06-安全與權限.md](06-安全與權限.md)〈提示注入〉。

## 概念

- **服務綁定（Service Binding）**：讓一個 Worker 直接呼叫同一個 Cloudflare 帳號裡的另一個 Worker。呼叫在 Cloudflare 內部完成，不經公網、沒有額外的網路延遲。
- **`WorkerEntrypoint`**：被呼叫的 Worker 匯出一個 class，裡面的 public 方法就是 RPC 方法。呼叫端像呼叫本地的 async 函式一樣使用它。
- **安全邊界在設定檔**：只有在 wrangler 設定裡宣告了這個 binding 的 Worker 才呼叫得到。RPC 方法沒有 URL，外部無法用 HTTP 打進來，所以不需要密鑰。
- **限制**：只能綁同一個帳號的 Worker。跨帳號或非 Cloudflare 的服務改用 [04](04-多服務串接與金鑰.md) 的做法。

## 書籤服務端：匯出 entrypoint

`src/index.ts` 目前是 `export default app`（Hono）。保留它，另外加一個具名匯出的 class：

```ts
// src/rpc.ts
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getBookmark, listBookmarks } from './db';
import { createBookmark } from './bookmarks'; // 與 REST 共用的新增流程

export class BookmarkRpc extends WorkerEntrypoint<Env> {
  async search(params: { q?: string; tag?: string; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(params.limit ?? 24, 1), 100);
    return listBookmarks(this.env.DB, { ...params, limit, offset: params.offset ?? 0 });
  }

  async get(id: number) {
    return (await getBookmark(this.env.DB, id)) ?? null;
  }

  async add(input: { url: string; note?: string }, caller: { client: string }) {
    // 通知信、webhook 用 this.ctx.waitUntil 在背景送出，跟 REST 一樣
    return createBookmark(this.env, this.ctx, input, caller);
  }
}
```

```ts
// src/index.ts 最後
export { BookmarkRpc } from './rpc';
export default app;
```

### 先抽出共用流程

REST 的 `POST /api/bookmarks` handler 裡有「正規化網址 → 查重 → `buildDraft` → `insertBookmark` → webhook → 通知信」整段邏輯，欄位長度限制也寫在 handler 裡。RPC 方法**不經過 Hono 的中介層與 handler**，所以要先把這些抽成共用函式，REST 與 RPC 都呼叫它。直接複製 handler 會讓兩邊的驗證規則慢慢分歧，例如 RPC 新增的書籤沒寄通知信。

## 閘道端：宣告 binding

```jsonc
// 閘道的 wrangler.jsonc
{
  "name": "mcp-gateway",
  "services": [
    { "binding": "BOOKMARKS", "service": "bookmark-shelf", "entrypoint": "BookmarkRpc" }
  ]
}
```

- `service` 是書籤 Worker 的 `name`（本專案 `wrangler.jsonc` 裡的 `bookmark-shelf`）。
- `entrypoint` 是匯出的 class 名稱；省略時綁的是 `export default`（也就是 HTTP 的 fetch）。

呼叫：

```ts
const result = await env.BOOKMARKS.search({ q: 'hono', limit: 10 });
```

### 型別

閘道與書籤服務是不同專案，閘道拿不到書籤服務的 `Env`。在閘道裡宣告一份介面描述 RPC 的形狀即可：

```ts
interface BookmarkService {
  search(params: { q?: string; tag?: string; limit?: number; offset?: number }): Promise<{ items: Bookmark[]; hasMore: boolean }>;
  get(id: number): Promise<Bookmark | null>;
  add(input: { url: string; note?: string }, caller: { client: string }): Promise<AddResult>;
}
```

RPC 方法改了簽名時，這份介面要跟著改；把它當成兩個服務之間的契約，放在閘道專案裡固定的一個檔案。

## 參數、回傳與錯誤

- 參數與回傳值以 structured clone 傳遞：用純物件、陣列、字串、數字、`Date`。不要傳 class 實例，方法會遺失。
- 自訂的錯誤類別（例如 `CrawlError`）跨過 RPC 後只剩 `Error` 與 message。可預期的結果（找不到、網址重複）用回傳值表達，例如 `{ ok: false, reason: 'duplicate', id: 12 }`；只有真正的例外才 throw。
- 呼叫者的身分（哪一個 OAuth client）由閘道當成參數傳進來，書籤服務用它寫呼叫紀錄。書籤服務不必、也無法自己驗證 OAuth token。

## 計價

服務綁定的呼叫怎麼計算請求數與 CPU 時間，以 Cloudflare Workers 官方計價頁為準。
