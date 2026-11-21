// BookmarkRpc：透過 ctx.exports 的 loopback binding 呼叫主 Worker 匯出的 entrypoint（等同閘道的服務綁定）
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, hookCalls, mockOutbound, PAGE_HTML } from './helpers/http';

type Json = Record<string, any>;

const rpc = () => (exports as unknown as { BookmarkRpc: Json }).BookmarkRpc;

async function restAdd(body: Json): Promise<Json> {
  return ((await (await api('/api/bookmarks', { method: 'POST', body })).json()) as Json).bookmark;
}

let outbound: ReturnType<typeof mockOutbound>;
beforeEach(() => {
  outbound = mockOutbound();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const caller = { client: 'test-client' };
const call = (tool: unknown, args?: unknown) => rpc().call(tool, args, caller);

// RPC 只剩 describe()、call()。舊方法若還在，閘道以外的呼叫者就能繞過 tool 的參數驗證與授權範圍
describe('舊的 RPC 方法已移除', () => {
  it('search、get、overview、add、preview、update、remove 都呼叫失敗，不動到資料', async () => {
    const created = await restAdd({ url: 'https://site.test/legacy', title: '舊方法' });
    const legacy: [string, unknown[]][] = [
      ['search', [{}]],
      ['get', [created.id]],
      ['overview', []],
      ['add', [{ url: 'https://site.test/legacy-add', title: '舊方法新增' }, caller]],
      ['preview', ['https://site.test/legacy-preview']],
      ['update', [created.id, { title: '被改了' }, caller]],
      ['remove', [created.id, caller]],
    ];
    // RPC stub 的回傳值不是原生 Promise，先轉成 Promise 再看結果
    for (const [name, args] of legacy) {
      const outcome = await Promise.resolve(rpc()[name](...args)).then(
        () => 'resolved',
        () => 'rejected',
      );
      expect(outcome, name).toBe('rejected');
    }
    expect((await call('bookmarks_get', { id: created.id })).data.bookmark.title).toBe('舊方法');
    expect((await call('bookmarks_search', { q: 'legacy-add' })).data.items).toEqual([]);
  });
});

describe('bookmarks_search', () => {
  it('items、hasMore 與 GET /api/bookmarks?q= 相同', async () => {
    await restAdd({ url: 'https://site.test/a', title: 'Hono 入門' });
    await restAdd({ url: 'https://site.test/b', title: '其他主題' });
    await restAdd({ url: 'https://site.test/c', title: 'hono 進階' });
    const rest = (await (await api('/api/bookmarks?q=hono')).json()) as Json;
    const result = (await call('bookmarks_search', { q: 'hono' })).data;
    expect(result.items.map((b: Json) => b.title)).toEqual(['hono 進階', 'Hono 入門']);
    expect(result.items.map((b: Json) => b.id)).toEqual(rest.items.map((b: Json) => b.id));
    expect(result.hasMore).toBe(rest.hasMore);
  });

  it('limit 預設 24、上限 100', async () => {
    for (let i = 0; i < 101; i++) await restAdd({ url: `https://site.test/many/${i}`, title: `第 ${i} 筆` });
    expect((await call('bookmarks_search', {})).data.items).toHaveLength(24);
    const result = (await call('bookmarks_search', { limit: 100 })).data;
    expect(result.items).toHaveLength(100);
    expect(result.hasMore).toBe(true);
  });
});

describe('bookmarks_overview', () => {
  it('回分類、標籤、網站清單', async () => {
    // 同一個測試檔共用 D1，用只在這裡出現的分類與標籤
    await restAdd({ url: 'https://site.test/o1', title: '一', category: '概覽分類', tags: '概覽甲,概覽乙' });
    await restAdd({ url: 'https://site.test/o2', title: '二', category: '概覽分類', tags: '概覽甲' });
    const result = (await call('bookmarks_overview', {})).data;
    expect(result.categories).toContainEqual({ name: '概覽分類', count: 2 });
    expect(result.tags).toContainEqual({ name: '概覽甲', count: 2 });
    expect(result.tags).toContainEqual({ name: '概覽乙', count: 1 });
    expect(result.sites.map((s: Json) => s.name)).toContain('site.test');
  });
});

describe('bookmarks_add 的通知', () => {
  it('跟 REST 一樣送出 webhook 與通知信', async () => {
    const send = vi.spyOn(env.EMAIL, 'send').mockResolvedValue({ messageId: 'test-id' } as never);
    await api('/api/webhooks', { method: 'POST', body: { event: 'bookmark.created', url: 'https://hooks.test/rpc-created' } });
    await api('/api/settings/mail', { method: 'PUT', body: { from: 'noreply@bookmarks.test', to: 'owner@bookmarks.test' } });
    const result = await call('bookmarks_add', { url: 'https://site.test/rpc-notify', title: '通知', summary: '摘要' });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => {
      expect(hookCalls(outbound)).toContain('https://hooks.test/rpc-created');
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect((send.mock.calls[0][0] as Json).to).toBe('owner@bookmarks.test');
  });
});

describe('契約外的欄位', () => {
  it('bookmarks_add 不收 extra、thumbnail、favicon', async () => {
    const result = await call('bookmarks_add', { url: 'https://site.test/rpc-extra', title: '多餘欄位', summary: '摘要', extra: { big: 'x' }, thumbnail: 'https://evil.test/t.png', favicon: 'https://evil.test/f.ico' });
    expect(result.ok).toBe(true);
    expect(result.data.bookmark.extra).toEqual({});
    expect(result.data.bookmark.thumbnail).toBe('');
    expect(result.data.bookmark.favicon).toBe('');
  });
});

describe('回傳值不含 share_id', () => {
  it('bookmarks_search、bookmarks_get、bookmarks_overview、bookmarks_add 都不帶 share_id', async () => {
    const added = (await call('bookmarks_add', { url: 'https://site.test/rpc-share', title: '分享', summary: '摘要' })).data.bookmark;
    const overview = (await call('bookmarks_overview', {})).data;
    const results = [
      added,
      ...(await call('bookmarks_search', { q: '分享' })).data.items,
      (await call('bookmarks_get', { id: added.id })).data.bookmark,
      ...overview.recent,
      ...overview.clicked,
    ];
    expect(results.every(Boolean)).toBe(true);
    for (const bookmark of results) expect(bookmark).not.toHaveProperty('share_id');
  });
});

describe('呼叫者寫進 Workers Logs', () => {
  it('bookmarks_add 的 console.log JSON 含 client、操作名稱與書籤 id', async () => {
    const log = vi.spyOn(console, 'log');
    const result = await call('bookmarks_add', { url: 'https://site.test/rpc-log', title: '紀錄', summary: '摘要' });
    const entries = log.mock.calls.flatMap(([line]) => {
      try {
        return [JSON.parse(String(line)) as Json];
      } catch {
        return [];
      }
    });
    expect(entries).toContainEqual(expect.objectContaining({ client: 'test-client', op: 'add', bookmark: result.data.bookmark.id }));
  });
});

describe('id 不是正整數', () => {
  it('bookmarks_get 回參數不正確', async () => {
    for (const id of [0, -1, 1.5, Number.NaN, '3', null]) {
      const result = await call('bookmarks_get', { id });
      expect(result.ok, String(id)).toBe(false);
      expect(result.message).toContain('參數不正確');
    }
  });
});

// 自動抓取要等外部網頁，這段時間別的請求可能先存進同一個網址：查重已經過了，寫入時才撞上 url 的 UNIQUE。
// 測試執行環境不會真的並行，改在「抓網頁」的當下由 mock 插入同一個網址來重現
describe('抓取網頁期間，同一個網址被別的請求先收藏', () => {
  function saveDuringCrawl(url: string) {
    let first: Promise<Json> | null = null;
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const target = input instanceof Request ? input.url : String(input);
      if (target === url) first ??= restAdd({ url, title: '先存進來的' });
      await first;
      if (new URL(target).hostname === 'hooks.test') return new Response('ok');
      return new Response(PAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    });
    return () => first!;
  }

  it('REST 回 409 並帶既有 id', async () => {
    const existing = saveDuringCrawl('https://site.test/race-rest');
    const res = await api('/api/bookmarks', { method: 'POST', body: { url: 'https://site.test/race-rest' } });
    expect([res.status, ((await res.json()) as Json).id]).toEqual([409, (await existing()).id]);
  });
});

// 服務自述：閘道不寫死 tool，改呼叫 describe() 取清單、call() 執行
describe('describe', () => {
  it('回服務名稱、兩個範圍與四個 tool，名稱都帶 bookmarks 前綴', async () => {
    const info = await rpc().describe();
    expect(info.label).toBe('書籤收藏櫃');
    expect(info.scopes.map((s: Json) => [s.scope, s.defaultChecked])).toEqual([
      ['bookmarks:read', true],
      ['bookmarks:write', false],
    ]);
    for (const scope of info.scopes) expect(scope).toEqual({ scope: expect.any(String), label: expect.any(String), description: expect.any(String), defaultChecked: expect.any(Boolean) });
    expect(info.tools.map((t: Json) => t.name)).toEqual(['bookmarks_search', 'bookmarks_get', 'bookmarks_overview', 'bookmarks_add']);
    for (const tool of info.tools) {
      expect(Object.keys(tool).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name', 'scopes', 'title']);
      expect(tool.name.startsWith('bookmarks_')).toBe(true);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.scopes.length).toBeGreaterThan(0);
      for (const scope of tool.scopes) expect(info.scopes.map((s: Json) => s.scope)).toContain(scope);
    }
  });

  it('bookmarks_add 的 url、title、summary 必填，只有它需要 bookmarks:write', async () => {
    const tools: Json[] = (await rpc().describe()).tools;
    const add = tools.find((t) => t.name === 'bookmarks_add')!;
    expect([...add.inputSchema.required].sort()).toEqual(['summary', 'title', 'url']);
    expect(add.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(tools.filter((t) => t.scopes.includes('bookmarks:write')).map((t) => t.name)).toEqual(['bookmarks_add']);
    for (const tool of tools.filter((t) => t !== add)) expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  });
});

describe('call', () => {
  it('bookmarks_search 回 { notice, items, hasMore }，notice 在最前面', async () => {
    await restAdd({ url: 'https://site.test/call-search', title: '呼叫搜尋' });
    const result = await call('bookmarks_search', { q: '呼叫搜尋' });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.data)).toEqual(['notice', 'items', 'hasMore']);
    expect(result.data.notice).toContain('提示注入');
    expect(result.data.items.map((b: Json) => b.title)).toEqual(['呼叫搜尋']);
    expect(result.data.items[0]).not.toHaveProperty('share_id');
  });

  it('bookmarks_get 回 { notice, bookmark }；找不到回 ok: false 與說明', async () => {
    const created = await restAdd({ url: 'https://site.test/call-get', title: '呼叫讀取' });
    const result = await call('bookmarks_get', { id: created.id });
    expect(Object.keys(result.data)).toEqual(['notice', 'bookmark']);
    expect(result.data.bookmark.title).toBe('呼叫讀取');
    expect(await call('bookmarks_get', { id: 99999 })).toEqual({ ok: false, message: '找不到 id 為 99999 的書籤' });
  });

  it('bookmarks_overview 回 notice 加概況', async () => {
    await restAdd({ url: 'https://site.test/call-overview', title: '呼叫概況', category: '呼叫分類' });
    const result = await call('bookmarks_overview', {});
    expect(result.ok).toBe(true);
    expect(Object.keys(result.data)[0]).toBe('notice');
    expect(result.data.categories).toContainEqual({ name: '呼叫分類', count: 1 });
    expect(result.data.total).toBeGreaterThan(0);
  });

  it('bookmarks_add 回 { bookmark }，不帶 notice、不連外，caller 寫進 log', async () => {
    const log = vi.spyOn(console, 'log');
    const result = await call('bookmarks_add', { url: 'https://site.test/call-add', title: ' 呼叫新增 ', summary: '摘要', tags: ['甲'] });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.data)).toEqual(['bookmark']);
    expect(result.data.bookmark).toMatchObject({ title: '呼叫新增', summary: '摘要', tags: ['甲'] });
    expect(result.data.bookmark).not.toHaveProperty('share_id');
    expect(outbound.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))).not.toContain('https://site.test/call-add');
    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).toContain('"client":"test-client"');
  });

  it('bookmarks_add 重複網址回既有 id', async () => {
    const created = await restAdd({ url: 'https://site.test/call-dup', title: '重複' });
    expect(await call('bookmarks_add', { url: 'https://site.test/call-dup', title: '又一次', summary: '摘要' })).toEqual({ ok: false, message: `這個網址已經收藏過了（既有書籤 id：${created.id}）` });
  });

  it('bookmarks_add 網址格式錯誤回書籤服務的訊息', async () => {
    expect(await call('bookmarks_add', { url: 'ftp://site.test/x', title: 'x', summary: 'y' })).toEqual({ ok: false, message: '只支援 http 與 https 網址' });
  });

  it('bookmarks_add 的 title、summary 全空白或沒帶時擋下，不寫入、不連外', async () => {
    const bad = [
      { url: 'https://site.test/call-blank', title: '   ', summary: '摘要' },
      { url: 'https://site.test/call-blank', title: '標題', summary: ' \n ' },
      { url: 'https://site.test/call-blank', summary: '摘要' },
      { url: 'https://site.test/call-blank', title: '標題' },
    ];
    for (const args of bad) {
      const result = await call('bookmarks_add', args);
      expect(result.ok, JSON.stringify(args)).toBe(false);
      expect(result.message).toContain('參數不正確');
    }
    expect((await call('bookmarks_search', { q: 'call-blank' })).data.items).toEqual([]);
    expect(outbound).not.toHaveBeenCalled();
  });

  it('參數型別不對回 ok: false，不丟例外', async () => {
    const bad: [string, unknown][] = [
      ['bookmarks_get', { id: '3' }],
      ['bookmarks_get', { id: 1.5 }],
      ['bookmarks_get', {}],
      ['bookmarks_get', null],
      ['bookmarks_get', 'x'],
      ['bookmarks_search', { limit: 500 }],
      ['bookmarks_search', { q: 1 }],
      ['bookmarks_add', { url: 1, title: 't', summary: 's' }],
      ['bookmarks_add', { url: 'https://site.test/call-type', title: 't', summary: 's', tags: '甲,乙' }],
    ];
    for (const [tool, args] of bad) {
      const result = await call(tool, args);
      expect(result.ok, `${tool} ${JSON.stringify(args)}`).toBe(false);
      expect(result.message).toContain('參數不正確');
      expect(result.message).not.toMatch(/\bat |src\/|node_modules/);
    }
  });

  it('不認得的 tool（含沒開放的 update、remove、preview 與原型上的鍵）回 ok: false', async () => {
    for (const tool of ['bookmarks_update', 'bookmarks_remove', 'bookmarks_preview', 'nope', 'constructor', '', 3, null]) {
      const result = await call(tool, {});
      expect(result.ok, String(tool)).toBe(false);
      expect(result.message).toContain('不認得的 tool');
    }
  });
});
