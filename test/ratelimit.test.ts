// 速率限制：REST 與 RPC 共用同一組名額。其他測試檔在 setup.ts 把間隔設成 0，這裡各測試自己打開
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMITS } from '../src/ratelimit';
import { api, mockOutbound } from './helpers/http';

type Json = Record<string, any>;

const rpc = () => (exports as unknown as { BookmarkRpc: Json }).BookmarkRpc;
const CALLER = { client: 'test' };
// 遠大於測試的執行時間：開著的時候，第二次呼叫一定還在間隔內
const LONG = 60_000;

let outbound: ReturnType<typeof mockOutbound>;
let seq = 0;
const nextUrl = () => `https://site.test/rate-${++seq}`;

// 每個測試從空的名額開始
beforeEach(async () => {
  outbound = mockOutbound();
  await env.DB.prepare('DELETE FROM rate_limits').run();
});
afterEach(() => {
  RATE_LIMITS.draft = 0;
  RATE_LIMITS.write = 0;
  vi.restoreAllMocks();
});

describe('寫入名額（新增、更新、刪除共用）', () => {
  it('REST：間隔內第二次寫入回 429 與 Retry-After，不寫入也不抓網頁', async () => {
    RATE_LIMITS.write = LONG;
    const first = await api('/api/bookmarks', { method: 'POST', body: { url: nextUrl(), title: '第一筆' } });
    expect(first.status).toBe(201);
    const { bookmark } = (await first.json()) as Json;
    outbound.mockClear();

    const blockedUrl = nextUrl();
    const add = await api('/api/bookmarks', { method: 'POST', body: { url: blockedUrl } });
    expect(add.status).toBe(429);
    expect(add.headers.get('Retry-After')).toBe('60');
    expect(((await add.json()) as Json).error).toContain('太頻繁');
    expect(outbound).not.toHaveBeenCalled();

    expect((await api(`/api/bookmarks/${bookmark.id}`, { method: 'PATCH', body: { note: 'x' } })).status).toBe(429);
    expect((await api(`/api/bookmarks/${bookmark.id}`, { method: 'DELETE' })).status).toBe(429);
    expect(((await (await api(`/api/bookmarks/${bookmark.id}`)).json()) as Json).bookmark.note).toBe('');

    // 間隔過了就恢復
    RATE_LIMITS.write = 0;
    expect((await api('/api/bookmarks', { method: 'POST', body: { url: blockedUrl, title: '第二筆' } })).status).toBe(201);
  });

  it('RPC：間隔內第二次 bookmarks_add 回 ok: false 與限流說明，不寫入', async () => {
    RATE_LIMITS.write = LONG;
    const add = (url: string, title: string) => rpc().call('bookmarks_add', { url, title, summary: '摘要' }, CALLER);
    expect((await add(nextUrl(), '第一筆')).ok).toBe(true);
    const blocked = await add(nextUrl(), '限流擋下的');
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain('太頻繁');
    expect(blocked.message).toContain('一次只送一個 tool 呼叫');
    expect(((await (await api(`/api/bookmarks?q=${encodeURIComponent('限流擋下的')}`)).json()) as Json).items).toEqual([]);
  });

  it('找不到書籤、網址重複不佔名額', async () => {
    const url = nextUrl();
    await api('/api/bookmarks', { method: 'POST', body: { url, title: '既有' } });
    RATE_LIMITS.write = LONG;
    expect((await api('/api/bookmarks', { method: 'POST', body: { url, title: '重複' } })).status).toBe(409);
    expect((await api('/api/bookmarks/999999', { method: 'DELETE' })).status).toBe(404);
    expect((await api('/api/bookmarks', { method: 'POST', body: { url: nextUrl(), title: '新的' } })).status).toBe(201);
  });
});

describe('抓取名額（預覽、只給網址的新增共用）', () => {
  it('間隔內第二次預覽回 429，不抓網頁', async () => {
    RATE_LIMITS.draft = LONG;
    expect((await api('/api/preview', { method: 'POST', body: { url: nextUrl() } })).status).toBe(200);
    outbound.mockClear();

    const res = await api('/api/preview', { method: 'POST', body: { url: nextUrl() } });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    // 只給網址的新增也要抓網頁
    expect((await api('/api/bookmarks', { method: 'POST', body: { url: nextUrl() } })).status).toBe(429);
    expect(outbound).not.toHaveBeenCalled();
  });

  it('預覽後立刻帶標題保存（設定頁「直接保存」的流程）不互相擋', async () => {
    RATE_LIMITS.draft = LONG;
    RATE_LIMITS.write = LONG;
    const url = nextUrl();
    const preview = await api('/api/preview', { method: 'POST', body: { url } });
    expect(preview.status).toBe(200);
    const { draft } = (await preview.json()) as Json;
    expect((await api('/api/bookmarks', { method: 'POST', body: { url, title: draft.title } })).status).toBe(201);
  });
});
