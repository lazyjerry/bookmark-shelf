# 書籤收藏櫃 API

這份文件說明如何用程式（捷徑、腳本、其他服務）存取書籤：建立應用程式帳密、在 header 帶入帳密、呼叫書籤的新增／查詢／更新／刪除 API，以及每次呼叫留下的紀錄。

以下範例的 `<你的網域>` 請換成部署後的網址，例如 `bookmark-shelf.<帳號>.workers.dev` 或自訂網域。

## 快速開始

1. 用瀏覽器登入，到「設定」→「應用程式帳密」，填寫名稱後按「建立帳密」，再輸入目前密碼確認（已新增 Passkey 的話，也可以按「用 Passkey 建立」驗證）。
2. 複製畫面上的帳號（`app-` 開頭）與密碼。**密碼只會顯示這一次**，伺服器只保存雜湊，之後無法再查看；遺失時刪除該組帳密再重建。
3. 呼叫 API：

```bash
AUTH='app-xxxxxxxxxxxx:<建立時顯示的密碼>'
curl -u "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/honojs/hono"}' https://<你的網域>/api/bookmarks
```

不想寫程式、只想從 iPhone／Mac 的分享選單收藏，用 [SHORTCUTS.md](SHORTCUTS.md) 的 Apple 捷徑即可，不必讀下面的內容。

## 認證

### 帳密放在 Authorization header

使用 HTTP Basic Auth：把 `帳號:密碼` 做 Base64 編碼，放在 `Authorization` header。

```
Authorization: Basic <base64(帳號:密碼)>
```

curl 的 `-u 帳號:密碼`、Python requests 的 `auth=(帳號, 密碼)` 都會自動產生這個 header。務必使用 HTTPS，Basic Auth 本身沒有加密。

### 兩種帳密的差別

| | 應用程式帳密 | 登入帳密（`AUTH_USER`／`AUTH_PASS`） |
|---|---|---|
| 建立方式 | 設定頁建立，可建多組（最多 20 組） | 環境變數，只有一組 |
| 可呼叫的路徑 | `/api/bookmarks`、`/api/bookmarks/:id`、`/api/preview` | 全部 API |
| 呼叫紀錄 | 有，見〈呼叫紀錄〉 | 沒有 |
| 停用方式 | 設定頁刪除該組，立即失效 | 更換密碼（`scripts/change-password.sh`） |

給程式使用時建議一律用應用程式帳密：每支程式各用一組，外流時只要刪掉那一組，不必更換登入密碼，也不能拿它改設定、新增帳密或 Passkey。

更換 `AUTH_PASS` 不會讓應用程式帳密失效，不再使用的請在設定頁刪除。

### 密碼的保存方式

- 帳號與密碼都由伺服器產生，密碼是 256 位元亂數（43 個字元的 base64url）。
- 資料庫只存密碼的 SHA-256，不存明碼；驗證時比對雜湊（等時比較）。
- 建立時需要再輸入一次目前的登入密碼。

## 共通規則

- 請求與回應都是 JSON。`POST`、`PATCH` 必須帶 `Content-Type: application/json`，否則回 415。
- 寫入請求（`GET` 以外）帶了 `Origin` header 時必須與網站同源，否則回 403（瀏覽器跨站請求的防護；一般程式不會帶這個 header）。
- 錯誤回應的格式為 `{ "error": "說明" }`。

| 狀態碼 | 情況 |
|---|---|
| 400 | 參數或 JSON 格式不正確、網址無法使用 |
| 401 | 帳密錯誤，或該組應用程式帳密已刪除 |
| 403 | 應用程式帳密呼叫了不允許的路徑；跨站請求 |
| 404 | 找不到書籤或 API |
| 409 | 網址已收藏過，回應會帶既有書籤的 `id` |
| 415 | 缺少 `Content-Type: application/json` |
| 500 | 伺服器錯誤 |
| 503 | 伺服器尚未設定 `AUTH_PASS`，整站停用 |

## 書籤物件

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | number | 書籤 id |
| `url` | string | 網址（已正規化：補上 `https://`、移除 `utm_*` 等追蹤參數），不可修改 |
| `title` | string | 標題，最多 300 字 |
| `summary` | string | 摘要，最多 2000 字 |
| `category` | string | 分類，最多 40 字 |
| `tags` | string[] | 標籤，最多 12 個、每個最多 30 字；去掉開頭的 `#`，不分大小寫去重 |
| `note` | string | 備註，最多 5000 字 |
| `thumbnail` | string | 縮圖網址，只接受 http(s)，其他值存成空字串 |
| `favicon` | string | 網站圖示網址 |
| `site` | string | 網站名稱 |
| `host` | string | 主機名稱 |
| `extra` | object | 擴充器附加的資料 |
| `click_count` | number | 點擊次數 |
| `created_at` `updated_at` | string | ISO 8601 時間 |
| `last_clicked_at` | string \| null | 最近點擊時間 |
| `share_id` | string | 中轉頁網址 `/b/<share_id>` 用的亂數，拿到網址的人免登入就能瀏覽 |

## 端點

### 新增書籤

```
POST /api/bookmarks
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `url` | 是 | 網址，最多 2048 字 |
| `title` | 否 | **沒有給 `title` 時**，伺服器會自動抓取網頁並以 AI 產生標題、摘要、分類與標籤，下列內容欄位會被忽略 |
| `summary` `category` `tags` `thumbnail` `favicon` `extra` | 否 | 有給 `title` 時才採用；`tags` 可以是陣列，或以逗號分隔的字串 |
| `note` | 否 | 備註，兩種模式都會採用 |

自動抓取通常要數秒，視目標網站與 AI 回應時間而定。

- `201`：`{ "bookmark": { … } }`
- `409`：`{ "error": "這個網址已經收藏過了", "id": 12 }`

透過 API 新增書籤，同樣會寄通知信、觸發 webhook，跟在網頁上新增一樣。

### 預覽（不保存）

```
POST /api/preview
```

`{ "url": "…" }` → `{ "draft": { … }, "duplicateId": 12 | null }`。`draft` 是自動抓取與 AI 整理的結果，欄位同書籤物件（沒有 `id`、`note` 等保存後才有的欄位），另有 `source.extractor`、`source.ai`、`source.warnings` 說明資料來源。適合先預覽、修改後再用 `POST /api/bookmarks` 帶 `title` 保存。

### 查詢書籤

```
GET /api/bookmarks
```

| 參數 | 說明 |
|---|---|
| `q` | 關鍵字，以空白分隔（最多 8 個，全部都要符合），比對標題、摘要、備註、網址、分類與標籤 |
| `site` `category` `tag` | 完全符合才列出 |
| `sort` | `created`（預設，最新建立）、`clicked`（最近點擊，只列出點擊過的）、`popular`（點擊最多） |
| `limit` | 1–100，預設 24 |
| `offset` | 預設 0 |

回應：`{ "items": [ … ], "hasMore": true }`。`hasMore` 為 `true` 時，把 `offset` 加上 `limit` 取下一頁。

### 讀取單筆

```
GET /api/bookmarks/:id
```

`200`：`{ "bookmark": { … } }`；找不到時回 `404`。

### 更新

```
PATCH /api/bookmarks/:id
```

只更新有傳的欄位：`title`、`summary`、`category`、`tags`、`note`、`thumbnail`。網址不可修改。

`200`：`{ "bookmark": { … } }`

### 刪除

```
DELETE /api/bookmarks/:id
```

`200`：`{ "ok": true }`

## 呼叫紀錄

應用程式帳密每次呼叫 API 都會留下一筆紀錄，在設定頁「應用程式帳密」列表按該組的「紀錄」查看。

### 記錄的內容

| 欄位 | 說明 |
|---|---|
| `created_at` | 呼叫時間 |
| `method` `path` | HTTP 方法與路徑（含查詢參數，最多 500 字） |
| `status` | 回應狀態碼，被擋下的越權呼叫（403）也會記錄 |
| `bookmark_id` | 操作到的書籤；新增時取自回應，網址重複（409）時為既有書籤 |
| `ip` | 來源 IP |
| `user_agent` | User-Agent，最多 300 字 |
| `duration_ms` | 處理時間（毫秒） |

不記錄的內容：

- **請求內容**：避免把備註等資料存進紀錄。
- **帳密錯誤的請求（401）**：驗證失敗時還無法確定是哪一組帳密；而且知道帳號的人可以大量送出錯誤密碼，把正常紀錄擠出保留上限。

### 保留天數與筆數

每組帳密各自設定，超過任一條件的舊紀錄會自動刪除：

| | 預設 | 範圍 |
|---|---|---|
| 保留天數 | 7 天 | 1–30 天 |
| 保留筆數 | 700 筆 | 1–10000 筆 |

- 建立帳密時設定，之後在「紀錄」對話框修改；調小時超出的紀錄立即刪除。
- 每寫入一筆新紀錄時，順便刪除過期與超量的紀錄。
- 刪除帳密時，它的紀錄一併刪除。

### 管理 API

以下 API 只能用瀏覽器登入（Session）或登入帳密呼叫，應用程式帳密呼叫會回 403。

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/api/settings/apps` | 列出應用程式帳密：`{ "apps": [ … ] }` |
| `POST` | `/api/settings/apps` | 建立：`{ "name", "currentPassword", "logDays", "logLimit" }`（後兩者可省略，取預設值；`currentPassword` 可改為 `passkey`，帶以 `/api/auth/passkey/options` 的選項簽出的驗證回應）；回 `201` 與 `{ "app", "password", "apps" }`，`password` 只出現這一次 |
| `PATCH` | `/api/settings/apps/:id` | 更新 `{ "name", "logDays", "logLimit" }`，只更新有傳的欄位 |
| `DELETE` | `/api/settings/apps/:id` | 刪除帳密與它的紀錄 |
| `GET` | `/api/settings/apps/:id/logs` | 呼叫紀錄，新的在前；參數 `limit`（預設 50，最多 200）、`offset`；回 `{ "logs": [ … ], "total": 123 }` |

`apps` 陣列中的每一項：`id`、`username`、`name`、`created_at`、`last_used_at`（最多每小時更新一次）、`log_days`、`log_limit`。

## 範例

### curl

```bash
AUTH='app-xxxxxxxxxxxx:<密碼>'
BASE='https://<你的網域>'

# 新增（自動抓取）
curl -u "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/article","note":"稍後再讀"}' "$BASE/api/bookmarks"

# 新增（自己提供內容，不抓取）
curl -u "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/b","title":"標題","summary":"摘要","tags":["閱讀","工具"]}' "$BASE/api/bookmarks"

# 查詢
curl -u "$AUTH" "$BASE/api/bookmarks?q=hono&limit=10"

# 讀取、更新、刪除
curl -u "$AUTH" "$BASE/api/bookmarks/12"
curl -u "$AUTH" -X PATCH -H 'Content-Type: application/json' \
  -d '{"note":"已讀","tags":["hono"]}' "$BASE/api/bookmarks/12"
curl -u "$AUTH" -X DELETE "$BASE/api/bookmarks/12"
```

### JavaScript（Node.js 18 以上）

```js
const BASE = 'https://<你的網域>';
const AUTH = 'Basic ' + Buffer.from(`${process.env.BOOKMARK_USER}:${process.env.BOOKMARK_PASS}`).toString('base64');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.error}`);
  return data;
}

const { bookmark } = await api('/api/bookmarks', { method: 'POST', body: { url: 'https://example.com/' } });
await api(`/api/bookmarks/${bookmark.id}`, { method: 'PATCH', body: { note: '從腳本新增' } });
```

### Python

```python
import os
import requests

BASE = 'https://<你的網域>'
auth = (os.environ['BOOKMARK_USER'], os.environ['BOOKMARK_PASS'])

r = requests.get(f'{BASE}/api/bookmarks', params={'q': 'hono', 'limit': 10}, auth=auth)
r.raise_for_status()
for item in r.json()['items']:
    print(item['id'], item['title'])
```

## 安全建議

- 密碼放在環境變數或系統的密碼管理工具，不要寫進程式碼或提交到版本控制。
- 每支程式各建一組帳密，名稱寫清楚用途，紀錄才看得出是誰呼叫的。
- 定期查看呼叫紀錄；出現不認得的 IP、User-Agent 或大量 403 時，立即刪除該組帳密。
- 不再使用的帳密直接刪除。
