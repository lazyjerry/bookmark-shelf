# 03 閘道登入與 OAuth

> 狀態：已實作（密碼登入；Passkey 尚未實作）。與下面範例的差異：`resourceMetadata.resource` 必須是絕對網址，閘道依請求的 origin 各建一個 `OAuthProvider` 並快取；MCP server 用 `agents` 套件的無狀態 `createMcpHandler`。另外加了設計沒寫到的三項：登入失敗節流（每個來源 IP 15 分鐘內最多驗 5 次密碼，計數存閘道的 D1）、登出、同意頁顯示導回網址。

## 為什麼閘道要有自己的登入

閘道在獨立網域上，書籤服務的兩種登入狀態都帶不過去：

- **Passkey 綁網域**：書籤服務 `src/passkeys.ts` 的 `relyingParty` 以請求的 hostname 當 `rpID`。在書籤網域註冊的 Passkey，在閘道網域無法使用。
- **登入 Cookie 綁 host**：`src/session.ts` 的 Cookie 使用 `__Host-` 前綴，只送給同一個 host。

所以閘道是自己的身分提供者：你在閘道登入一次，閘道再代表你呼叫各個服務。

## 閘道的登入方式

| 方式 | 做法 |
|---|---|
| 密碼 | `wrangler secret put GATEWAY_PASS`，比對時用等時比較 |
| Passkey | 在閘道網域另外註冊；`rpID` 是閘道的 hostname。做法可參考書籤服務的 `src/passkeys.ts` |
| Session | 登入後發閘道自己的 Cookie，只用在授權頁，不用在 `/mcp` |

`/mcp` 只認 OAuth access token，不認登入 Cookie。

## OAuth 元件

使用 Cloudflare 的 `@cloudflare/workers-oauth-provider`，它把 OAuth 2.1 授權伺服器包成 Worker 的 default export，token 與授權紀錄存在 KV。

```jsonc
// 閘道的 wrangler.jsonc
{
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<KV id>" }]
}
```

```ts
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';

export default new OAuthProvider({
  apiRoute: '/mcp',                 // 需要 access token 的路徑
  apiHandler: mcpHandler,           // MCP server
  defaultHandler: authHandler,      // 登入頁、同意頁等其他路徑
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register', // MCP client 動態註冊
});
```

套件會自動提供 OAuth metadata（`/.well-known/...`），未帶 token 的 `/mcp` 請求會收到指向它的 401，MCP client 就能自己走授權流程。

## 授權流程

1. client 動態註冊後，把你導到 `<閘道網域>/authorize`。
2. `authHandler` 用 `env.OAUTH_PROVIDER.parseAuthRequest(request)` 解析授權請求。
3. 還沒登入就先顯示登入頁（密碼或 Passkey）。
4. 顯示同意頁：client 名稱，以及可勾選的服務與權限（例如 `bookmarks:read`、`bookmarks:write`，各範圍的意思見 [06](06-安全與權限.md)）。
5. 你按同意後呼叫 `env.OAUTH_PROVIDER.completeAuthorization({ request, userId, scope, props, metadata })`，把勾選結果放進 `props`。
6. client 換到 access token，之後每次呼叫 `/mcp`，`apiHandler` 都能從 `ctx.props` 讀到當初授權的範圍。

## MCP server

`apiHandler` 是 MCP server 本身。Cloudflare 的 `agents` 套件有兩種寫法：

- **`McpAgent`**：每個連線一個 Durable Object，可以保存連線狀態。需要另外宣告 Durable Object binding。
- **無狀態 handler**：每個請求獨立處理，不需要 Durable Objects。

閘道的 tools 都是「呼叫服務、回傳結果」，沒有要跨請求保存的狀態，優先選無狀態。

tool 清單依 `ctx.props` 的範圍過濾：只有 `bookmarks:read` 的 token，在 `tools/list` 裡就看不到新增、刪除這類 tool。

## 撤銷

- 套件提供列出、撤銷授權的 helper，閘道的設定頁用它列出目前有哪些 client 拿到授權，並可以逐一撤銷。
- 更換 `GATEWAY_PASS` 不會讓已發出的 token 失效，要另外撤銷。
