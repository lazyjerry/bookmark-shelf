import { github } from './github';
import { youtube } from './youtube';
import type { DomainExtractor } from './types';

export type { DomainExtractor, ExtractContext, ExtractResult } from './types';

/**
 * 網域擴充器清單，依序比對、第一個 match 的生效。
 * 新增網域：在本目錄建立實作 DomainExtractor 的檔案，再加進這個陣列。
 */
export const EXTRACTORS: DomainExtractor[] = [github, youtube];

export function findExtractor(url: URL): DomainExtractor | undefined {
  return EXTRACTORS.find((extractor) => extractor.match(url));
}
