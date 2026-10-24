import type { PageMeta } from '../types';

export interface ExtractContext {
  url: URL;
  env: Env;
  /** 通用爬蟲結果。需要頁面 meta 時才呼叫；多次呼叫只會抓一次 */
  fetchMeta(): Promise<PageMeta>;
}

/**
 * 擴充器回傳的欄位全部選填，沒給的由通用流程補上。
 * - title、description、image、favicon、text：取代通用爬蟲的同名欄位
 * - summary：有值就直接當摘要，AI 不會改寫
 * - tags、category：與 AI 結果合併；AI 停用時直接採用
 * - aiInstructions：附加在 AI 提示詞後的特殊摘要規則
 * - extra：存進書籤的 extra 欄位（JSON），前端會顯示
 */
export interface ExtractResult {
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  text?: string;
  keywords?: string[];
  summary?: string;
  tags?: string[];
  category?: string;
  aiInstructions?: string;
  extra?: Record<string, unknown>;
  warnings?: string[];
}

export interface DomainExtractor {
  /** 顯示在草稿來源與 log 的名稱 */
  name: string;
  match(url: URL): boolean;
  /** 回傳 null 代表放棄，改走通用爬蟲 */
  extract(ctx: ExtractContext): Promise<ExtractResult | null>;
}
