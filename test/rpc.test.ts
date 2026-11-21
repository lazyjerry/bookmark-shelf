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

describe('search', () => {
  it('回傳與 GET /api/bookmarks?q= 相同的 items、hasMore', async () => {
    await restAdd({ url: 'https://site.test/a', title: 'Hono 入門' });
    await restAdd({ url: 'https://site.test/b', title: '其他主題' });
    await restAdd({ url: 'https://site.test/c', title: 'hono 進階' });
    const rest = (await (await api('/api/bookmarks?q=hono')).json()) as Json;
    const result = await rpc().search({ q: 'hono' });
    expect(result.items.map((b: Json) => b.title)).toEqual(['hono 進階', 'Hono 入門']);
    expect(result.items.map((b: Json) => b.id)).toEqual(rest.items.map((b: Json) => b.id));
    expect(result.hasMore).toBe(rest.hasMore);
  });

  it('limit 超過 100 時以 100 計', async () => {
    for (let i = 0; i < 101; i++) await restAdd({ url: `https://site.test/many/${i}`, title: `第 ${i} 筆` });
    const result = await rpc().search({ limit: 500 });
    expect(result.items).toHaveLength(100);
    expect(result.hasMore).toBe(true);
  });
});

describe('search 的 sort', () => {
  it('不在清單裡的值（含 constructor 這類原型上的鍵）照預設排序，不出錯', async () => {
    await restAdd({ url: 'https://site.test/sort-a', title: '排序 A' });
    await restAdd({ url: 'https://site.test/sort-b', title: '排序 B' });
    const expected = (await rpc().search({ q: '排序' })).items.map((b: Json) => b.id);
    for (const sort of ['constructor', 'toString', '__proto__', 'nope']) {
      expect((await rpc().search({ q: '排序', sort })).items.map((b: Json) => b.id), sort).toEqual(expected);
    }
  });
});

describe('get', () => {
  it('找得到回書籤，找不到回 null', async () => {
    const created = await restAdd({ url: 'https://site.test/get', title: '取得' });
    expect((await rpc().get(created.id)).title).toBe('取得');
    expect(await rpc().get(99999)).toBeNull();
  });
});

describe('overview', () => {
  it('回分類、標籤、網站清單', async () => {
    // 同一個測試檔共用 D1，用只在這裡出現的分類與標籤
    await restAdd({ url: 'https://site.test/o1', title: '一', category: '概覽分類', tags: '概覽甲,概覽乙' });
    await restAdd({ url: 'https://site.test/o2', title: '二', category: '概覽分類', tags: '概覽甲' });
    const result = await rpc().overview();
    expect(result.categories).toContainEqual({ name: '概覽分類', count: 2 });
    expect(result.tags).toContainEqual({ name: '概覽甲', count: 2 });
    expect(result.tags).toContainEqual({ name: '概覽乙', count: 1 });
    expect(result.sites.map((s: Json) => s.name)).toContain('site.test');
  });
});

describe('preview', () => {
  it('回草稿與 duplicateId', async () => {
    const fresh = await rpc().preview('https://site.test/preview');
    expect(fresh.draft.title).toBe('測試頁面標題');
    expect(fresh.duplicateId).toBeNull();
    const created = await restAdd({ url: 'https://site.test/preview', title: '已收藏' });
    expect((await rpc().preview('https://site.test/preview')).duplicateId).toBe(created.id);
  });
});

describe('preview 連不上網站', () => {
  it('警告只有固定文字，不帶連線錯誤的細節', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await rpc().preview('https://unreachable.test/x');
    expect(JSON.stringify(result)).toContain('無法連線到這個網站');
    expect(JSON.stringify(result)).not.toContain('測試不允許連外');
  });
});

const caller = { client: 'test-client' };

describe('add', () => {
  it('新增成功回 { ok: true, bookmark }', async () => {
    const result = await rpc().add({ url: 'https://site.test/rpc-add' }, caller);
    expect(result.ok).toBe(true);
    expect(result.bookmark.title).toBe('測試頁面標題');
    expect((await rpc().get(result.bookmark.id)).url).toBe('https://site.test/rpc-add');
  });

  it('重複網址回 { ok: false, reason: duplicate, id }', async () => {
    const created = await restAdd({ url: 'https://site.test/rpc-dup', title: '重複' });
    expect(await rpc().add({ url: 'https://site.test/rpc-dup', title: '又一次' }, caller)).toEqual({ ok: false, reason: 'duplicate', id: created.id });
  });

  it('網址格式錯誤回 { ok: false, reason: invalid, message }', async () => {
    expect(await rpc().add({ url: 'ftp://site.test/x', title: 'x' }, caller)).toEqual({ ok: false, reason: 'invalid', message: '只支援 http 與 https 網址' });
  });

  it('跟 REST 一樣送出 webhook 與通知信', async () => {
    const send = vi.spyOn(env.EMAIL, 'send').mockResolvedValue({ messageId: 'test-id' } as never);
    await api('/api/webhooks', { method: 'POST', body: { event: 'bookmark.created', url: 'https://hooks.test/rpc-created' } });
    await api('/api/settings/mail', { method: 'PUT', body: { from: 'noreply@bookmarks.test', to: 'owner@bookmarks.test' } });
    const result = await rpc().add({ url: 'https://site.test/rpc-notify', title: '通知' }, caller);
    expect(result.ok).toBe(true);
    await vi.waitFor(() => {
      expect(hookCalls(outbound)).toContain('https://hooks.test/rpc-created');
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect((send.mock.calls[0][0] as Json).to).toBe('owner@bookmarks.test');
  });
});

describe('契約外的欄位', () => {
  it('add 不收 extra、thumbnail、favicon', async () => {
    const result = await rpc().add({ url: 'https://site.test/rpc-extra', title: '多餘欄位', extra: { big: 'x' }, thumbnail: 'https://evil.test/t.png', favicon: 'https://evil.test/f.ico' }, caller);
    expect(result.ok).toBe(true);
    expect(result.bookmark.extra).toEqual({});
    expect(result.bookmark.thumbnail).toBe('');
    expect(result.bookmark.favicon).toBe('');
  });

  it('update 不收 thumbnail', async () => {
    const created = await restAdd({ url: 'https://site.test/rpc-thumb', title: '縮圖' });
    const result = await rpc().update(created.id, { note: '有改', thumbnail: 'https://evil.test/t.png' }, caller);
    expect(result.bookmark.note).toBe('有改');
    expect(result.bookmark.thumbnail).toBe('');
  });
});

describe('update、remove', () => {
  it('update 成功回新內容；找不到回 not_found', async () => {
    const created = await restAdd({ url: 'https://site.test/rpc-update', title: '舊' });
    const result = await rpc().update(created.id, { title: '新' }, caller);
    expect(result.ok).toBe(true);
    expect(result.bookmark.title).toBe('新');
    expect(await rpc().update(99999, { title: 'x' }, caller)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('remove 成功後 get 回 null；找不到回 not_found', async () => {
    const created = await restAdd({ url: 'https://site.test/rpc-remove', title: '刪' });
    expect((await rpc().remove(created.id, caller)).ok).toBe(true);
    expect(await rpc().get(created.id)).toBeNull();
    expect(await rpc().remove(created.id, caller)).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('回傳值不含 share_id', () => {
  it('search、get、overview、add、update、remove 都不帶 share_id', async () => {
    const added = await rpc().add({ url: 'https://site.test/rpc-share', title: '分享' }, caller);
    const id = added.bookmark.id;
    const results = [
      added.bookmark,
      ...(await rpc().search({ q: '分享' })).items,
      await rpc().get(id),
      ...(await rpc().overview()).recent,
      (await rpc().update(id, { note: '備註' }, caller)).bookmark,
      (await rpc().remove(id, caller)).bookmark,
    ];
    expect(results.every(Boolean)).toBe(true);
    for (const bookmark of results) expect(bookmark).not.toHaveProperty('share_id');
  });
});

describe('呼叫者寫進 Workers Logs', () => {
  it('add 帶 caller 時，console.log 的 JSON 含 client 與操作名稱', async () => {
    const log = vi.spyOn(console, 'log');
    const result = await rpc().add({ url: 'https://site.test/rpc-log', title: '紀錄' }, { client: 'test-client' });
    const entries = log.mock.calls.flatMap(([line]) => {
      try {
        return [JSON.parse(String(line)) as Json];
      } catch {
        return [];
      }
    });
    expect(entries).toContainEqual(expect.objectContaining({ client: 'test-client', op: 'add', bookmark: result.bookmark.id }));
  });
});

describe('id 不是正整數', () => {
  const badIds = [0, -1, 1.5, Number.NaN, '3', null];

  it('get 回 null', async () => {
    for (const id of badIds) expect(await rpc().get(id)).toBeNull();
  });

  it('update、remove 回 { ok: false, reason: invalid }，不動到資料', async () => {
    const created = await restAdd({ url: 'https://site.test/bad-id', title: '原標題' });
    for (const id of badIds) {
      expect(await rpc().update(id, { title: '被改了' }, { client: 't' })).toEqual({ ok: false, reason: 'invalid', message: 'id 不正確' });
      expect(await rpc().remove(id, { client: 't' })).toEqual({ ok: false, reason: 'invalid', message: 'id 不正確' });
    }
    expect((await rpc().get(created.id)).title).toBe('原標題');
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

  it('RPC add 回 duplicate 並帶既有 id', async () => {
    const existing = saveDuringCrawl('https://site.test/race-rpc');
    const result = await rpc().add({ url: 'https://site.test/race-rpc' }, { client: 't' });
    expect(result).toEqual({ ok: false, reason: 'duplicate', id: (await existing()).id });
  });

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
  const call = (tool: unknown, args?: unknown) => rpc().call(tool, args, caller);

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
    expect((await rpc().search({ q: 'call-blank' })).items).toEqual([]);
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
