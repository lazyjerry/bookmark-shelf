import { exports } from 'cloudflare:workers';
import { vi } from 'vitest';

export const ORIGIN = 'https://bookmarks.test';
const AUTH = 'Basic ' + btoa('admin:test-pass');

/** 以 Basic Auth 呼叫書籤 API；有 body 時送 JSON */
export function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { Authorization: AUTH };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return exports.default.fetch(ORIGIN + path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export const PAGE_HTML = '<!doctype html><html><head><title>測試頁面標題</title><meta name="description" content="測試頁面描述"></head><body><p>內文</p></body></html>';

/**
 * 攔截對外 fetch：site.test 回固定 HTML，hooks.test（webhook 目標）回 200，其他網址一律失敗。
 * 回傳 spy，可檢查 webhook 被呼叫幾次
 */
export function mockOutbound() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'site.test') return new Response(PAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (url.hostname === 'hooks.test') return new Response('ok');
    throw new Error(`測試不允許連外：${url}`);
  });
}

export function hookCalls(spy: ReturnType<typeof mockOutbound>): string[] {
  return spy.mock.calls
    .map(([input]) => (input instanceof Request ? input.url : String(input)))
    .filter((url) => new URL(url).hostname === 'hooks.test');
}
