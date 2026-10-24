# 書籤收藏櫃 Bookmark Shelf

蒐集平時不會用到，但是可能會有需要的網站、點子、功能與靈感。貼上網址，自動抓取標題、摘要與縮圖，再由 Workers AI 分類並加上標籤。跑在 Cloudflare Workers + D1，整站需登入（密碼或 Passkey），可安裝成 PWA。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lazyjerry/bookmark-shelf)

## 功能

- **登入**：整站（頁面與 API）都需登入；未設定 `AUTH_PASS` 時一律回應 503，不會預設開放。瀏覽器在登入頁以密碼或 Passkey（Face ID、Touch ID、Windows Hello）登入，Session 保留 30 天、使用中自動延長，PWA 關掉重開也不必重新登入；程式呼叫（捷徑、curl）照舊帶 Basic Auth。登入帳密只由 `AUTH_USER`／`AUTH_PASS` 設定，設定頁不能修改。
- **新增書籤**：輸入網址 → 爬蟲抓 `title`、`og:*`、`description`、favicon 與內文摘錄 → AI 產生標題、繁中摘要、分類與標籤 → 確認、補備註後保存。AI 失敗或停用時改用爬蟲結果與規則分類。
- **分頁**：頂列選單切換三個分頁。
  - **新增與列表**：以新增書籤為主，附最近新建、最近點擊與全部書籤。
  - **搜尋與列表**：以搜尋為主，附網站分類（GitHub、Threads、Instagram……）、內容分類、標籤分類（依數量排序）與全部書籤。
  - **設定**：個人資料（姓名、登入帳號）、登入方式（Passkey、登出其他裝置）與通知信。
- **欄位**：網址、標題、摘要、分類、標籤、備註、縮圖（`og:image`）、favicon，另記點擊次數與時間。
- **網域擴充器**：針對特定網域改寫抓取與摘要規則，內建 GitHub（API、README、topics，可讀 Private Repo）與 YouTube（oEmbed）。
- **Webhook**：新增、更新、刪除、點擊書籤時呼叫指定網址，支援 POST JSON、POST 表單與 GET，可選 HMAC 簽章。設定介面目前隱藏，API 仍可使用。
- **PWA**：可安裝到桌面或手機主畫面；Android 可從其他 App「分享」網址直接新增。
- **通知信**：新增書籤時，寄網站資料（標題、網址、網站、分類、標籤、縮圖）與摘要給設定頁指定的收件人。走 Cloudflare Email Routing，只寄得到已驗證的收件地址。

## 部署

### 一鍵部署

按上方按鈕，Cloudflare 會複製 repository、建立 D1 資料庫、執行 migration 並部署。過程中會要求填入：

| 名稱 | 說明 |
|---|---|
| `AUTH_PASS` | 登入密碼（secret）。可用 `openssl rand -base64 24` 產生 |
| `AUTH_USER` | 登入帳號，預設 `admin` |
| `AI_MODEL` | Workers AI 模型，需支援 JSON Mode，預設 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `AI_ENABLED` | 設為 `false` 停用 AI |

### 手動部署

```bash
npm install
npx wrangler login
npx wrangler deploy                      # 第一次部署會自動建立 D1 資料庫
npm run db:migrations:apply              # 建立資料表
npx wrangler secret put AUTH_PASS        # 設定登入密碼
```

之後更新用 `npm run deploy`（先跑 migration 再部署）。

### 更換登入密碼

設定頁不能改密碼，登入密碼只由 secret `AUTH_PASS` 決定。用腳本互動更換（需先 `npx wrangler login`）：

```bash
sh scripts/change-password.sh
```

1. 選擇自行輸入新密碼（至少 8 個字元，輸入兩次，不會顯示在畫面上），或自動產生隨機密碼（`openssl rand -base64 24`）。
2. 確認後以 `wrangler secret put AUTH_PASS` 寫進已部署的 Worker，舊密碼立即失效，不必重新部署。密碼經 stdin 傳給 wrangler，不會留在 shell 歷史。
3. 自動產生的密碼只在完成時顯示一次，請存進密碼管理器。

已登入的瀏覽器與 App 不會因此登出，要的話到設定頁「登入方式」按「登出其他裝置」；Passkey 不受影響。本機的 `.dev.vars` 不會跟著改。要改帳號時，修改 `wrangler.jsonc` 的 `AUTH_USER` 後重新部署。

### 綁定自訂網域

網域需已在同一個 Cloudflare 帳號中：

```bash
npx wrangler deploy --domain <你的網域>
```

不寫進 `wrangler.jsonc`，以免透過一鍵部署的人因為沒有該網域而失敗。也可以在 Dashboard 的 Worker → Settings → Domains & Routes 設定。

### 選用設定

| 名稱 | 說明 |
|---|---|
| `GITHUB_TOKEN` | GitHub Personal Access Token（secret）。未設定時 GitHub API 常因共用 IP 達到速率上限而退回一般爬蟲；要讀 Private Repo 時需給 repo 讀取權限。設定：`npx wrangler secret put GITHUB_TOKEN` |

### 新增書籤通知信

`wrangler.jsonc` 已宣告 `send_email` binding（`EMAIL`），不限制收件地址。寄送走 Email Routing，免費、任何方案都能用，但只寄得到帳號裡已驗證的收件地址：

1. 寄件網域需託管在 Cloudflare，並在 Dashboard → 該網域 → Email → Email Routing 啟用。
2. 每個收件地址在 Email Routing → Destination addresses 新增，對方點開驗證信。
3. 到設定頁「通知信」填寄件地址（該網域下任一地址，例如 `bookmark@<你的網域>`）與收件地址，儲存後按「寄測試信」，逐一回報每個地址的結果。

收件地址清空即停止寄送。寄送在背景執行，失敗只記在 Worker log（`message: "mail"`），不影響新增書籤。本機 `npm run dev` 不會真的寄出，信件內容存到 `.wrangler/tmp/email/`。

## 本機開發

```bash
npm install
cp .dev.vars.example .dev.vars           # 修改 AUTH_PASS
npm run db:migrations:local
npm run dev                              # http://localhost:8787
npm run typecheck
```

本機開發時 AI binding 仍會呼叫遠端 Workers AI，需先 `npx wrangler login`，並可能產生用量費用。

## 隱私與安全

- 書籤只存在你自己帳號的 D1，不經過第三方服務；AI 推論使用你帳號的 Workers AI。
- 寫入 API 只接受同源、`Content-Type: application/json` 的請求，避免瀏覽器自動帶 Cookie 或 Basic Auth 被跨站利用。
- 縮圖與 favicon 只接受 http(s) 網址；頁面以 `textContent` 呈現使用者資料。
- `manifest.webmanifest`、`sw.js`、`offline.html`、`app.css`、`app.js`、`favicon.svg` 與 `/icons/*` 不需登入（瀏覽器抓 manifest 與圖示時不帶認證，擋住會無法安裝 PWA）。這些檔案不含任何書籤資料。
- Webhook 的簽章密鑰不會回傳到前端。
- 登入帳密只由 `AUTH_USER`／`AUTH_PASS` 設定，設定頁不能修改。改密碼用 `sh scripts/change-password.sh`（見「更換登入密碼」）；既有 Session 不會因此失效，改完到設定頁按「登出其他裝置」。
- 登入頁（`/login`、`login.js`、`passkey.js`）與 `/api/auth/*` 不需登入。未登入的頁面導覽轉到登入頁，登入後回到原網址（含 PWA 分享進來的網址）；瀏覽器的 API 請求回 401 但不帶 `WWW-Authenticate`，不會跳出瀏覽器內建的登入框。
- Session Cookie 為 `__Host-` 前綴、`HttpOnly`、`Secure`、`SameSite=Lax`，帶 `Max-Age`（iOS 主畫面 App 被系統關掉後，沒有效期的 Cookie 會消失）。D1 只存 token 的 SHA-256。
- Passkey 要求使用者驗證（生物辨識或裝置 PIN，伺服器分不出是哪一種），新增時需再輸入目前密碼；challenge 5 分鐘內有效、只能用一次。密碼一直都能登入；遺失裝置時在設定頁刪除該 Passkey，或：

  ```bash
  npx wrangler d1 execute DB --remote --command "DELETE FROM passkeys; DELETE FROM sessions"
  ```

## API

除了 `/api/auth/*` 之外都需登入：程式呼叫帶 Basic Auth，瀏覽器用登入頁換到的 Session Cookie。寫入請求需帶 `Content-Type: application/json`。

| 方法 | 路徑 | 說明 |
|---|---|---|
| `POST` | `/api/preview` | `{ "url" }` → 產生草稿（不保存），回傳 `draft` 與 `duplicateId` |
| `POST` | `/api/bookmarks` | 只給 `{ "url" }` 時自動抓取並保存；帶 `title` 時以傳入欄位為準 |
| `GET` | `/api/bookmarks` | 參數：`q`、`site`、`category`、`tag`、`sort`（`created`／`clicked`／`popular`）、`limit`、`offset` |
| `GET` `PATCH` `DELETE` | `/api/bookmarks/:id` | 讀取、更新（`title`、`summary`、`category`、`tags`、`note`、`thumbnail`）、刪除 |
| `GET` | `/api/overview` | 首頁區塊資料 |
| `GET` | `/go/:id` | 記錄點擊後轉址 |
| `GET` `POST` | `/api/webhooks` | 列出、新增 webhook |
| `PATCH` `DELETE` | `/api/webhooks/:id` | 更新、刪除 webhook |
| `POST` | `/api/webhooks/:id/test` | 以最新一筆書籤實際呼叫一次 |
| `GET` `PATCH` | `/api/settings` | 讀取設定、更新姓名 `{ "name" }` |
| `GET` `PUT` | `/api/settings/mail` | 讀取、更新通知信 `{ "from", "to" }`（`to` 為陣列，或以換行、逗號分隔的字串，最多 10 個） |
| `POST` | `/api/settings/mail/test` | 以最新一筆書籤寄測試信，回傳每個收件地址的結果 |
| `POST` | `/api/auth/login` | `{ "username", "password" }` 登入，發 Session Cookie（免登入） |
| `POST` | `/api/auth/passkey/options`、`/api/auth/passkey` | Passkey 登入：取得 challenge、送出驗證結果（免登入） |
| `POST` | `/api/auth/logout` | 登出目前的 Session（免登入） |
| `GET` | `/api/settings/login` | 已新增的 Passkey 與登入中的 Session 數 |
| `POST` | `/api/settings/passkeys/options`、`/api/settings/passkeys` | 新增 Passkey：`{ "currentPassword" }` 取得選項，再送 `{ "name", "response" }` |
| `DELETE` | `/api/settings/passkeys/:id` | 刪除 Passkey |
| `DELETE` | `/api/settings/sessions` | 登出目前這個以外的所有 Session |

例如用捷徑或腳本直接收藏：

```bash
curl -u admin:<密碼> -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/honojs/hono"}' https://<你的網域>/api/bookmarks
```

## Webhook

| 事件 | 時機 |
|---|---|
| `bookmark.created` | 新增書籤 |
| `bookmark.updated` | 編輯書籤 |
| `bookmark.deleted` | 刪除書籤 |
| `bookmark.clicked` | 從列表點開書籤 |
| `*` | 以上全部 |

每個 webhook 指定一個事件與呼叫方式，不同事件可接到不同網址。請求都帶 `X-Bookmark-Event` 標頭。

- **POST JSON**：`{ "event", "timestamp", "bookmark": { …完整書籤… } }`
- **POST 表單**：`application/x-www-form-urlencoded`，欄位為 `event`、`timestamp`、`id`、`url`、`title`、`summary`、`category`、`tags`（逗號分隔）、`note`、`site`、`thumbnail`、`click_count`、`created_at`、`extra`（JSON 字串）
- **GET**：同表單欄位，附加在 webhook 網址的查詢字串後

設定簽章密鑰時，`X-Bookmark-Signature: sha256=<hex>` 為密鑰對「POST 的 body」或「GET 的查詢字串（不含 `?`）」做 HMAC-SHA256 的結果。驗證範例（Node.js）：

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const expected = Buffer.from('sha256=' + createHmac('sha256', SECRET).update(rawBody).digest('hex'));
const received = Buffer.from(req.headers['x-bookmark-signature'] ?? '');
const valid = received.length === expected.length && timingSafeEqual(received, expected);
```

## 網域擴充器

在 `src/extractors/` 新增實作 `DomainExtractor` 的檔案，再加進 `src/extractors/index.ts` 的 `EXTRACTORS` 陣列。依序比對，第一個 `match` 的生效。

```ts
import type { DomainExtractor } from './types';

export const example: DomainExtractor = {
  name: 'Example',
  match: (url) => url.hostname === 'example.com',
  async extract({ url, env, fetchMeta }) {
    const meta = await fetchMeta();          // 需要時才呼叫通用爬蟲
    return {
      title: meta.title,
      description: meta.description,
      category: '工具',
      aiInstructions: '摘要說明這個工具能做什麼。',
      extra: { source: 'example' },
    };
  },
};
```

`extract` 的回傳欄位全部選填，沒給的由通用流程補上：

| 欄位 | 用途 |
|---|---|
| `title`、`description`、`image`、`favicon`、`text`、`keywords` | 取代通用爬蟲的同名結果 |
| `summary` | 有值就直接當摘要，AI 不會改寫 |
| `category`、`tags` | AI 停用時直接採用；AI 啟用時作為建議並合併 |
| `aiInstructions` | 附加在 AI 提示詞後的特殊摘要規則 |
| `extra` | 存進書籤的 `extra` 欄位（JSON） |
| `warnings` | 顯示在新增畫面的提醒 |

回傳 `null` 代表放棄，改走通用爬蟲；丟出錯誤也會退回通用爬蟲並顯示提醒。內建的 [github.ts](src/extractors/github.ts) 示範了 Private Repo 的特殊摘要規則。

## PWA 圖示

圖示由腳本產生，修改設計後重新執行（需 Pillow）：

```bash
python3 scripts/generate-icons.py
```

更新 `public/` 中被 Service Worker 快取的檔案後，把 [public/sw.js](public/sw.js) 的 `CACHE` 版本加一。

## 已知限制

- Instagram、Threads 等站的縮圖是有時效的 CDN 網址，過一段時間可能失效，可在編輯畫面改縮圖網址。
- 需要登入或以 JavaScript 產生內容的頁面，爬蟲只能拿到公開的 meta。
- 搜尋使用子字串比對，適合個人規模的書籤量（數千筆內）。
- Passkey 綁定網域：`*.workers.dev` 與自訂網域是不同的 Passkey，要各自在設定頁新增。
- 曾用舊版 Basic Auth 登入過的瀏覽器會一直自動帶舊帳密，「登出」清不掉，要關閉瀏覽器或清除網站資料。

## 專案結構

```
├── migrations/0001_init.sql    D1 資料表
├── migrations/0002_settings.sql 個人設定
├── migrations/0003_sessions_passkeys.sql 登入 Session、Passkey、WebAuthn challenge
├── migrations/0005_drop_auth_settings.sql 清掉舊版設定頁存的登入帳密
├── public/                     前端頁面、PWA manifest、Service Worker、圖示
├── scripts/generate-icons.py   產生 PWA 圖示
├── scripts/change-password.sh  互動更換登入密碼（wrangler secret put AUTH_PASS）
├── src/
│   ├── index.ts                路由、Basic Auth、API
│   ├── crawler.ts              網址正規化與 HTMLRewriter 擷取 meta
│   ├── enrich.ts               擴充器 → 爬蟲 → AI 的草稿流程
│   ├── ai.ts                   Workers AI 標題、摘要、分類、標籤
│   ├── db.ts                   D1 查詢
│   ├── sites.ts                網域 → 網站分類對照
│   ├── webhooks.ts             Webhook 呼叫與簽章
│   ├── mailer.ts               新增書籤通知信
│   ├── settings.ts             個人設定、登入帳密驗證
│   ├── session.ts              瀏覽器登入的 Session Cookie
│   ├── passkeys.ts             Passkey（WebAuthn）註冊與驗證
│   └── extractors/             網域擴充器
└── wrangler.jsonc
```
