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
