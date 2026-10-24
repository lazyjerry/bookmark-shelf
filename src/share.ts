// 書籤中轉頁 /b/<share_id>：免登入可瀏覽與分享。未登入的訪客拿不到備註、點擊數與內部 id
import { getBookmarkByShareId } from './db';
import type { Bookmark } from './types';

const SHARE_ID = /^[0-9a-f]{24}$/;
// 只轉 raster 圖：SVG 可以帶 script，從本站網域送出等於開了 XSS
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function findShared(db: D1Database, shareId: string): Promise<Bookmark | null> {
  return SHARE_ID.test(shareId) ? getBookmarkByShareId(db, shareId) : null;
}

export function publicBookmark(b: Bookmark) {
  const { stars, language, author } = b.extra;
  return {
    share_id: b.share_id, url: b.url, title: b.title, summary: b.summary, category: b.category, tags: b.tags,
    thumbnail: b.thumbnail, favicon: b.favicon, site: b.site, host: b.host, created_at: b.created_at,
    extra: { stars, language, author },
  };
}

function setContent(value: string): HTMLRewriterElementContentHandlers {
  return { element: (el) => void el.setAttribute('content', value) };
}

/**
 * 依書籤改寫 view.html 的 title 與 og meta，貼到通訊軟體時才有預覽卡；找不到書籤時回 404，頁面自己顯示訊息。
 * 標題、描述與 image:alt 都帶上收藏櫃名稱與來源網站，預覽卡看得出是分享的書籤，不會跟原網頁的卡片一模一樣
 */
export function viewPage(page: Response, bookmark: Bookmark | null, pageUrl: string): Response {
  const headers = new Headers(page.headers);
  headers.delete('ETag');
  headers.set('Cache-Control', 'private, no-cache');
  if (!bookmark) return new Response(page.body, { status: 404, headers });

  const title = `${bookmark.title || bookmark.url}｜書籤收藏櫃`;
  const source = bookmark.site || bookmark.host;
  const description = `收藏自 ${source}${bookmark.category ? `・${bookmark.category}` : ''}｜${bookmark.summary}`.slice(0, 160);
  return new HTMLRewriter()
    .on('title', { element: (el) => void el.setInnerContent(title) })
    .on('meta[name="description"]', setContent(description))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[property="og:url"]', setContent(pageUrl))
    .on('meta[property="og:image"]', bookmark.thumbnail ? setContent(bookmark.thumbnail) : { element: (el) => void el.remove() })
    .on('meta[property="og:image:alt"]', bookmark.thumbnail ? setContent(`${source} 的書籤縮圖`) : { element: (el) => void el.remove() })
    .transform(new Response(page.body, { headers }));
}

/**
 * 轉送書籤縮圖。分享圖在瀏覽器用 Canvas 畫，跨站圖片會汙染 Canvas 而無法匯出，所以從同源取。
 * 只轉這筆書籤自己的縮圖，不接受任意網址，不會變成開放代理
 */
export async function thumbnailResponse(bookmark: Bookmark): Promise<Response> {
  if (!bookmark.thumbnail) return new Response('沒有縮圖', { status: 404 });
  let res: Response;
  try {
    res = await fetch(bookmark.thumbnail, { headers: { Accept: 'image/*' }, cf: { cacheTtl: 86_400, cacheEverything: true } });
  } catch {
    return new Response('無法取得縮圖', { status: 502 });
  }
  const type = (res.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (!res.ok || !IMAGE_TYPES.has(type)) return new Response('無法取得縮圖', { status: 502 });
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_IMAGE_BYTES) return new Response('縮圖太大', { status: 502 });
  return new Response(body, {
    headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
  });
}
