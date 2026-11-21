# 專案規則

書籤收藏櫃：Cloudflare Worker（Hono + D1 + Workers AI），前端是 `public/` 的靜態頁與 PWA。功能、部署、API 與專案結構見 `README.md`。

## 文件放哪裡

| 內容 | 位置 |
|---|---|
| 使用者操作、部署、設定說明 | `README.md` |
| 程式化存取（應用程式帳密、書籤 CRUD、呼叫紀錄） | `API.md` |
| Apple 捷徑 | `SHORTCUTS.md`；README 與 API.md 只放一句指向它 |
| 技術教學、架構說明 | `docs/教學/`；寫教學，或新增、改名、搬移該資料夾的檔案前，先讀 `docs/教學/索引.md` 的〈使用規範〉，照它的分檔、命名、狀態標示與索引更新規則做 |
| 施工結論、計畫檔 | `docs/working-notes-skill/` |

## 改動時連帶同步

- **`public/` 任一前端檔**：`public/sw.js` 的 `CACHE` 版本號加一，commit 訊息註明加到第幾版。
- **API 新增或改動**：README〈API〉表與 `API.md` 一起改。
- **新增檔案或目錄**：README〈專案結構〉補一行。
- **D1 schema**：新增下一號 `migrations/NNNN_*.sql`；已套用的 migration 保持原樣。
- **`wrangler.jsonc` 的 vars 或 binding**：跑 `npm run types` 重產型別；使用者可調的變數在 `package.json` 的 `cloudflare.bindings` 補一句說明（一鍵部署頁面會顯示）。
- **免登入路徑**：加進 `src/index.ts` 的 `PUBLIC_PATHS`，並在 README〈隱私與安全〉寫明為什麼免登入、不含哪些資料。
- **開放給應用程式帳密的 API**：加進 `src/index.ts` 的 `APP_PATH`，並同步 README〈隱私與安全〉與 `API.md` 列出的可呼叫路徑。
- **書籤的新增、更新、刪除邏輯**：改在 `src/bookmarks.ts`，REST handler 與 `BookmarkRpc` 都呼叫它，不寫回個別 handler。
- **`src/rpc.ts` 的 `BookmarkRpc`**：與 MCP 閘道的契約是 `describe()`（服務名稱、授權範圍、tool 清單）與 `call(tool, args, caller)` 兩個方法的形狀，閘道 repo 裡沒有書籤服務專屬的程式。tool、範圍、參數限制與回應文字改在 `src/tools.ts`，部署後閘道就會拿到，不必改閘道；tool 名稱以 `bookmarks_` 開頭、範圍以 `bookmarks:` 開頭，不符合的會被閘道丟掉。要改 `describe()`／`call()` 本身的形狀時，照「這邊先新增 → 閘道改用 → 這邊再移除舊的」分次部署，見 `docs/教學/05-本機開發與部署.md`〈改 RPC 介面時〉。

## 設定的限制

- `wrangler.jsonc` 保持通用：自訂網域與 D1 `database_id` 留在設定檔外，一鍵部署的人沒有那個 zone 或資料庫。綁網域用 `wrangler deploy --domain`，資料庫由首次 deploy 依 `database_name` 建立。
- 部署用 `npm run deploy`（先套遠端 migration 再 deploy）。

## 驗證

- 型別：`npm run typecheck`。
- 測試：`npm test`（Vitest + `@cloudflare/vitest-plugin`，跑在真的 Workers runtime，中文路徑可直接跑）。測試在 `test/`，都從 `cloudflare:workers` 的 `exports` 進入：REST 走 `exports.default.fetch`（`test/helpers/http.ts`），RPC 走 `exports.BookmarkRpc`；設定裡 AI 關閉、不連遠端 binding，對外 `fetch` 在測試內以 `vi.spyOn` 攔截。改到書籤 API 或 `src/bookmarks.ts`、`src/rpc.ts` 時先寫會紅的測試再改。
- 前端與畫面：`npm run db:migrations:local` 加 `npm run dev`，以 curl 或 Playwright 手動驗證。
- 本機的 AI binding 仍呼叫遠端 Workers AI、會計費；用不到 AI 的驗證在 `.dev.vars` 設 `AI_ENABLED=false`。

## 文字

- 介面、文件、commit 訊息用繁體中文台灣用語。
- `src/ai.ts` 的提示詞要明列台灣用語對照：模型實測會產出「數據庫」這類中國用語。
- commit 訊息沿用 `git log` 的格式：`feat:`／`fix:`／`style:`／`docs:` 加中文摘要，細節用 ` - ` 條列。
