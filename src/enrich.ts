import { aiEnabled, aiEnrich } from './ai';
import { fetchPageMeta, normalizeUrl, safeUrl } from './crawler';
import { getVocabulary, normalizeTags } from './db';
import { findExtractor, type ExtractResult } from './extractors';
import { defaultCategoryOf, hostOf, siteOf } from './sites';
import type { BookmarkDraft, PageMeta } from './types';

// 擴充器的 topics 加上 AI 標籤可能很多，草稿只留前幾個
const MAX_DRAFT_TAGS = 8;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fallbackTitle(url: URL): string {
  if (url.pathname === '/') return hostOf(url);
  try {
    return hostOf(url) + decodeURI(url.pathname);
  } catch {
    return hostOf(url) + url.pathname;
  }
}

/**
 * 網址 → 書籤草稿：
 * 1. 網域擴充器（有符合的話），失敗或回傳 null 時改走通用爬蟲
 * 2. 規則產生預設的標題、摘要、分類、標籤
 * 3. AI 啟用時改寫標題、摘要並分類；AI 失敗就保留規則結果
 */
export async function buildDraft(env: Env, rawUrl: string): Promise<BookmarkDraft> {
  const url = normalizeUrl(rawUrl);
  const target = new URL(url);
  const warnings: string[] = [];

  let metaPromise: Promise<PageMeta> | null = null;
  const fetchMeta = () => (metaPromise ??= fetchPageMeta(url));

  let result: ExtractResult | null = null;
  let extractorName = '通用爬蟲';
  const extractor = findExtractor(target);
  if (extractor) {
    try {
      result = await extractor.extract({ url: target, env, fetchMeta });
      if (result) extractorName = extractor.name;
    } catch (err) {
      warnings.push(`${extractor.name} 擴充器失敗：${errorMessage(err)}`);
    }
  }
  if (!result) {
    try {
      result = await fetchMeta();
    } catch (err) {
      warnings.push(`無法抓取頁面：${errorMessage(err)}`);
      result = {};
    }
  }
  warnings.push(...(result.warnings ?? []));

  const site = siteOf(target);
  const draft: BookmarkDraft = {
    url,
    title: result.title || fallbackTitle(target),
    summary: result.summary || result.description || (result.text ?? '').slice(0, 160),
    category: result.category || defaultCategoryOf(site),
    tags: normalizeTags([...(result.tags ?? []), ...(result.keywords ?? [])].slice(0, 6)),
    thumbnail: safeUrl(result.image ?? ''),
    favicon: safeUrl(result.favicon ?? '') || safeUrl('/favicon.ico', url),
    site,
    host: hostOf(target),
    extra: result.extra ?? {},
    source: { extractor: extractorName, ai: false, warnings },
  };

  if (aiEnabled(env)) {
    try {
      const vocabulary = await getVocabulary(env.DB);
      const ai = await aiEnrich(env, {
        url,
        site,
        title: result.title ?? '',
        description: result.description ?? '',
        keywords: result.keywords ?? [],
        text: result.text ?? '',
        // 擴充器給的分類放最前面當建議
        categories: [...new Set([result.category, ...vocabulary.categories].filter((c): c is string => Boolean(c)))],
        tags: vocabulary.tags,
        instructions: result.aiInstructions,
      });
      if (ai.title) draft.title = ai.title;
      // 擴充器明確給了摘要就不讓 AI 改寫
      if (ai.summary && !result.summary) draft.summary = ai.summary;
      if (ai.category) draft.category = ai.category;
      draft.tags = normalizeTags([...(result.tags ?? []), ...ai.tags]).slice(0, MAX_DRAFT_TAGS);
      draft.source.ai = true;
    } catch (err) {
      warnings.push(`AI 產生失敗，改用爬蟲結果：${errorMessage(err)}`);
    }
  }

  return draft;
}
