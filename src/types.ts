// 選用 secret：不在 wrangler.jsonc 宣告，wrangler types 不會產生
declare global {
  interface Env {
    GITHUB_TOKEN?: string;
  }
}

/** 爬蟲從頁面擷取的原始資訊 */
export interface PageMeta {
  url: string;
  title: string;
  description: string;
  siteName: string;
  image: string;
  favicon: string;
  keywords: string[];
  /** 內文摘錄，給 AI 產生摘要用 */
  text: string;
}

/** 新增前的草稿：爬蟲＋擴充器＋AI 的整合結果 */
export interface BookmarkDraft {
  url: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  thumbnail: string;
  favicon: string;
  site: string;
  host: string;
  extra: Record<string, unknown>;
  source: {
    extractor: string;
    ai: boolean;
    warnings: string[];
  };
}

export interface Bookmark {
  id: number;
  url: string;
  title: string;
  summary: string;
  category: string;
  note: string;
  tags: string[];
  thumbnail: string;
  favicon: string;
  site: string;
  host: string;
  extra: Record<string, unknown>;
  click_count: number;
  created_at: string;
  updated_at: string;
  last_clicked_at: string | null;
}
