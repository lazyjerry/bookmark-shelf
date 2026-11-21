# 02 服務綁定與 RPC

> 狀態：已實作。`BookmarkRpc` 只有 `describe()`、`call()` 兩個方法（見〈服務自述〉）；早期的 `search`、`get`、`overview`、`add`、`preview`、`update`、`remove` 在閘道改用 `call()` 後已移除。與下面範例的差異：另有 `bookmarks_overview`；`caller` 由 `src/rpc.ts` 寫進 Workers Logs，不進 D1；書籤不回 `share_id`；新增只取契約內的欄位，多帶的不採用。只開放查詢與新增的原因見 [06-安全與權限.md](06-安全與權限.md)〈提示注入〉。

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
import { callTool, describeService, type ToolOps } from './tools';

// tool 實際執行的操作。不寫成 BookmarkRpc 的方法：class 上的 public 方法都會開放成 RPC，
// 呼叫者就能繞過 call() 的參數驗證與閘道的授權範圍
function toolOps(env: Env, ctx: ExecutionContext): ToolOps {
  return {
    async search(params) {
      const limit = Math.min(Math.max(params.limit ?? 24, 1), 100);
      return listBookmarks(env.DB, { ...params, limit, offset: params.offset ?? 0 });
    },
    async get(id) {
      return (await getBookmark(env.DB, id)) ?? null;
    },
    async add(input, caller) {
      // 通知信、webhook 用 ctx.waitUntil 在背景送出，跟 REST 一樣
      return createBookmark(env, ctx, input, env.APP_URL ?? '');
    },
  };
}

export class BookmarkRpc extends WorkerEntrypoint<Env> {
  async describe() {
    return describeService();
  }

  async call(tool: string, args: unknown, caller: { client: string }) {
    return callTool(toolOps(this.env, this.ctx), tool, args, caller);
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
// 閘道的 wrangler.jsonc（不進版控，從 wrangler.example.jsonc 複製後填 services）
{
  "name": "mcp-gateway",
  "services": [
    { "binding": "BOOKMARKS", "service": "bookmark-shelf", "entrypoint": "BookmarkRpc" }
  ]
}
```

- `service` 是書籤 Worker 的 `name`（本專案 `wrangler.jsonc` 裡的 `bookmark-shelf`）。
- `entrypoint` 是匯出的 class 名稱；省略時綁的是 `export default`（也就是 HTTP 的 fetch）。

閘道 repo 不放任何服務的資訊：上面這份 `wrangler.jsonc` 列入 `.gitignore`，repo 只追蹤不含 `services` 的 `wrangler.example.jsonc`；接上哪些服務寫在 `SERVICES`（逗號分隔的 binding 名稱，例如 `BOOKMARKS`），本機放 `.dev.vars`，線上是 secret。檔案配置見 [05](05-本機開發與部署.md)〈專案放哪裡〉。

## 服務自述：`describe()` 與 `call()`

閘道不寫死每個服務的 tool、授權範圍與 RPC 方法，改由服務自己描述。每個服務的 entrypoint 都實作同樣的兩個方法，閘道對 `SERVICES` 列出的每個 binding 一視同仁：

```ts
// 閘道裡唯一的服務介面，所有服務共用
interface Service {
  describe(): Promise<{
    label: string;            // 同意頁顯示的服務名稱
    scopes: { scope: string; label: string; description: string; defaultChecked: boolean }[];
    tools: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;    // JSON Schema，最外層 type: 'object'
      annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
      scopes: string[];       // 列出與呼叫都需要的範圍
    }[];
  }>;
  call(tool: string, args: unknown, caller: { client: string }): Promise<{ ok: true; data: unknown } | { ok: false; message: string }>;
}
```

- **`describe()`** 回傳純物件。閘道用 `scopes` 產生同意頁的勾選項目，用 `tools` 回應 `tools/list`，`inputSchema` 原樣交給 AI client。結果在閘道的同一個 isolate 留 60 秒，服務改了 tool 或範圍，部署後最多一分鐘生效。
- **`call()`** 執行一個 tool。可預期的結果（找不到、重複、參數不合法、超過速率限制、不認得的 tool 名稱）回 `{ ok: false, message }`，`message` 會原樣顯示給 AI client，不放堆疊與內部路徑；只有真正的例外才 throw。
- **閘道強制前綴**：閘道以 binding 名稱小寫當服務名稱（`BOOKMARKS` → `bookmarks`），tool 名稱不是 `bookmarks_` 開頭、範圍不是 `bookmarks:` 開頭的一律丟掉。一個服務無法宣告或冒用別的服務的 tool 與範圍。
- **服務自己驗參數**：閘道只拿 `inputSchema` 做 JSON Schema 驗證，服務不能假設參數已經驗過。JSON Schema 也表達不了所有規則，例如「去掉空白後不為空」。

書籤服務的定義在 `src/tools.ts`：每個 tool 一份 zod schema，`describe()` 用 `z.toJSONSchema()` 轉成 `inputSchema`，`call()` 用同一份 schema 驗證參數，兩邊不會對不上。`bookmarks_add` 的 `title`、`summary` 用 `.trim().min(1)` 擋掉全空白的值：共用流程 `createBookmark` 收到空的標題會自己去抓網頁，MCP 這條路不讓伺服器連外。

```ts
// src/rpc.ts
async describe() {
  return describeService();
}

async call(tool: string, args: unknown, caller: Caller) {
  return callTool(toolOps(this.env, this.ctx), tool, args, caller);
}
```

這樣切之後，新增或調整 tool 只要改服務並部署，閘道不必動；兩邊之間的契約只剩上面這份介面。

## 參數、回傳與錯誤

- 參數與回傳值以 structured clone 傳遞：用純物件、陣列、字串、數字、`Date`。不要傳 class 實例，方法會遺失。
- 自訂的錯誤類別（例如 `CrawlError`）跨過 RPC 後只剩 `Error` 與 message。可預期的結果（找不到、網址重複）用回傳值表達，例如 `{ ok: false, reason: 'duplicate', id: 12 }`；只有真正的例外才 throw。
- 呼叫者的身分（哪一個 OAuth client）由閘道當成參數傳進來，書籤服務用它寫呼叫紀錄。書籤服務不必、也無法自己驗證 OAuth token。

## 計價

服務綁定的呼叫怎麼計算請求數與 CPU 時間，以 Cloudflare Workers 官方計價頁為準。
