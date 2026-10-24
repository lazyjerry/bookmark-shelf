import type { DomainExtractor } from './types';

interface OEmbed {
  title: string;
  author_name: string;
  author_url: string;
  thumbnail_url: string;
}

/** YouTube 影片：用 oEmbed 取標題、頻道與縮圖，描述沿用頁面 meta */
export const youtube: DomainExtractor = {
  name: 'YouTube',

  match(url) {
    const host = url.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtu.be') return url.pathname.length > 1;
    return host === 'youtube.com' && (url.pathname === '/watch' || url.pathname.startsWith('/shorts/'));
  },

  async extract({ url, fetchMeta }) {
    const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.toString())}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const data = (await res.json()) as OEmbed;
    const meta = await fetchMeta().catch(() => null);

    return {
      title: data.title,
      description: meta?.description ?? '',
      text: meta?.text ?? '',
      keywords: meta?.keywords ?? [],
      image: data.thumbnail_url,
      favicon: 'https://www.youtube.com/favicon.ico',
      category: '影音',
      extra: { author: data.author_name, author_url: data.author_url },
    };
  },
};
