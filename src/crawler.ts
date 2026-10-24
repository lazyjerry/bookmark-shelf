import type { PageMeta } from './types';

const USER_AGENT = 'Mozilla/5.0 (compatible; BookmarkShelf/1.0; link preview)';
const FETCH_TIMEOUT_MS = 10_000;
// 只讀前 1.5 MB：meta 都在 <head>，內文摘錄有前幾段就夠
const MAX_BYTES = 1_500_000;
const TEXT_LIMIT = 4_000;

// 分享連結常見的追蹤參數，存檔前移除，避免同一頁存成多筆
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|igsh|igshid|mibextid)$/i;

export class CrawlError extends Error {}

/** 補上 https://、只允許 http(s)、移除追蹤參數。不合法時丟出 CrawlError */
export function normalizeUrl(input: string): string {
  let raw = input.trim();
  if (!raw) throw new CrawlError('請輸入網址');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CrawlError('網址格式不正確');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CrawlError('只支援 http 與 https 網址');
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

/** 只接受 http(s) 的絕對網址；相對路徑以 base 解析。其他一律回傳空字串 */
export function safeUrl(value: string, base?: string): string {
  if (!value) return '';
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// HTMLRewriter 給的屬性值與文字都是原始 HTML，需自行解碼實體
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? all;
  });
}

export function cleanText(text: string): string {
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function capStream(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (seen >= max) {
          controller.terminate();
          return;
        }
        seen += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
}

function fileNameOf(url: string): string {
  const name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** 抓取頁面並擷取 title、meta、og、favicon 與內文摘錄 */
export async function fetchPageMeta(url: string): Promise<PageMeta> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (err) {
    throw new CrawlError(`無法連線：${err instanceof Error ? err.message : String(err)}`);
  }

  const finalUrl = res.url || url;
  const meta: PageMeta = { url: finalUrl, title: '', description: '', siteName: '', image: '', favicon: '', keywords: [], text: '' };

  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new CrawlError(`網站回應 HTTP ${res.status}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!/html|xml/i.test(contentType)) {
    await res.body.cancel();
    meta.title = fileNameOf(finalUrl);
    if (contentType.startsWith('image/')) meta.image = finalUrl;
    return meta;
  }

  const tags: Record<string, string> = {};
  let title = '';
  let titleCount = 0;
  let icon = '';
  let touchIcon = '';
  let text = '';

  const rewriter = new HTMLRewriter()
    .on('title', {
      element() {
        titleCount++;
      },
      text(chunk) {
        if (titleCount === 1) title += chunk.text;
      },
    })
    .on('meta', {
      element(el) {
        const key = (el.getAttribute('property') ?? el.getAttribute('name') ?? el.getAttribute('itemprop') ?? '').toLowerCase();
        const content = el.getAttribute('content');
        if (key && content && !(key in tags)) tags[key] = content;
      },
    })
    .on('link[rel]', {
      element(el) {
        const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
        const href = el.getAttribute('href') ?? '';
        if (!href) return;
        if (rel.includes('icon') && !icon) icon = href;
        if (rel.includes('apple-touch-icon') && !touchIcon) touchIcon = href;
      },
    })
    .on('p', {
      text(chunk) {
        if (text.length >= TEXT_LIMIT) return;
        text += chunk.text;
        if (chunk.lastInTextNode) text += ' ';
      },
    });

  const html = new Response(capStream(res.body, MAX_BYTES), { headers: { 'content-type': contentType } });
  await rewriter.transform(html).arrayBuffer();

  const pick = (...keys: string[]) => cleanText(keys.map((k) => tags[k]).find(Boolean) ?? '');

  meta.title = pick('og:title', 'twitter:title') || cleanText(title);
  meta.description = pick('og:description', 'description', 'twitter:description');
  meta.siteName = pick('og:site_name', 'application-name');
  meta.image = safeUrl(pick('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'), finalUrl);
  meta.favicon = safeUrl(cleanText(icon || touchIcon) || '/favicon.ico', finalUrl);
  meta.keywords = pick('keywords')
    .split(/[,，、]/)
    .map((k) => k.trim())
    .filter(Boolean);
  meta.text = cleanText(text).slice(0, TEXT_LIMIT);
  return meta;
}

/** 讀取回應文字，最多 max bytes，超過就截斷並取消剩下的串流 */
export async function readTextCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size >= max) await reader.cancel();
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all.subarray(0, Math.min(size, max)));
}
