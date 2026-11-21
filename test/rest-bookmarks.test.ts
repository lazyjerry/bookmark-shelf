// 特性測試：鎖住 REST 書籤 API 現有的行為，抽出共用流程前後都要是綠的
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, hookCalls, mockOutbound } from './helpers/http';

type Json = Record<string, any>;

let outbound: ReturnType<typeof mockOutbound>;
beforeEach(() => {
  outbound = mockOutbound();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/bookmarks', () => {
  it('只給 url：回 201，標題取自網頁 <title>，網址去掉 utm_*', async () => {
    const res = await api('/api/bookmarks', { method: 'POST', body: { url: 'https://site.test/page?utm_source=x&id=1' } });
    expect(res.status).toBe(201);
    const { bookmark } = (await res.json()) as Json;
    expect(bookmark.title).toBe('測試頁面標題');
    expect(bookmark.url).toBe('https://site.test/page?id=1');
  });

  it('同一網址再新增：回 409，帶既有書籤的 id', async () => {
    const first = (await (await api('/api/bookmarks', { method: 'POST', body: { url: 'https://site.test/dup' } })).json()) as Json;
    const res = await api('/api/bookmarks', { method: 'POST', body: { url: 'https://site.test/dup' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).id).toBe(first.bookmark.id);
  });

  it('帶 title：採用傳入的 summary 與 tags（逗號字串轉陣列、去 #、不分大小寫去重）', async () => {
    const res = await api('/api/bookmarks', {
      method: 'POST',
      body: { url: 'https://site.test/manual', title: '自訂標題', summary: '自訂摘要', tags: '#Hono, hono,Workers' },
    });
    expect(res.status).toBe(201);
    const { bookmark } = (await res.json()) as Json;
    expect(bookmark.title).toBe('自訂標題');
    expect(bookmark.summary).toBe('自訂摘要');
    expect(bookmark.tags).toEqual(['Hono', 'Workers']);
    // 帶 title 時不抓網頁
    expect(outbound.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).includes('site.test'))).toHaveLength(0);
  });

  it('欄位超長被截斷：title 301 字存成 300 字', async () => {
    const res = await api('/api/bookmarks', { method: 'POST', body: { url: 'https://site.test/long', title: '長'.repeat(301) } });
    const { bookmark } = (await res.json()) as Json;
    expect(bookmark.title).toHaveLength(300);
  });

  it('新增後送出 webhook 一次，並寄通知信給設定的收件人', async () => {
    const send = vi.spyOn(env.EMAIL, 'send').mockResolvedValue({ messageId: 'test-id' } as never);
    await api('/api/webhooks', { method: 'POST', body: { event: 'bookmark.created', url: 'https://hooks.test/created' } });
    await api('/api/settings/mail', { method: 'PUT', body: { from: 'noreply@bookmarks.test', to: 'owner@bookmarks.test' } });

    const res = await api('/api/bookmarks', { method: 'POST', body: { url: 'https://site.test/notify', title: '通知測試' } });
    expect(res.status).toBe(201);
    await vi.waitFor(() => {
      expect(hookCalls(outbound)).toEqual(['https://hooks.test/created']);
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect((send.mock.calls[0][0] as Json).to).toBe('owner@bookmarks.test');
  });
});

describe('PATCH /api/bookmarks/:id', () => {
  it('只更新有傳的欄位，url 不可改', async () => {
    const created = (await (
      await api('/api/bookmarks', { method: 'POST', body: { url: 'https://site.test/patch', title: '原標題', summary: '原摘要' } })
    ).json()) as Json;
    const res = await api(`/api/bookmarks/${created.bookmark.id}`, { method: 'PATCH', body: { title: '新標題', url: 'https://site.test/other' } });
    expect(res.status).toBe(200);
    const { bookmark } = (await res.json()) as Json;
    expect(bookmark.title).toBe('新標題');
    expect(bookmark.summary).toBe('原摘要');
    expect(bookmark.url).toBe('https://site.test/patch');
  });

  it('不存在的 id 回 404', async () => {
    const res = await api('/api/bookmarks/99999', { method: 'PATCH', body: { title: 'x' } });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/bookmarks/:id', () => {
  it('回 { ok: true }，之後 GET 回 404', async () => {
    const created = (await (await api('/api/bookmarks', { method: 'POST', body: { url: 'https://site.test/delete', title: '刪除' } })).json()) as Json;
    const res = await api(`/api/bookmarks/${created.bookmark.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await api(`/api/bookmarks/${created.bookmark.id}`)).status).toBe(404);
  });
});
