import type { Bookmark } from './types';

const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 30;
const MAX_SEARCH_TOKENS = 8;

// 標籤依加入順序回傳（bookmark_tags 有 rowid）
const SELECT_BOOKMARK = `SELECT b.*,
  (SELECT json_group_array(tag) FROM (SELECT tag FROM bookmark_tags WHERE bookmark_id = b.id ORDER BY rowid)) AS tags_json
FROM bookmarks b`;

type Row = Omit<Bookmark, 'tags' | 'extra'> & { tags_json: string | null; extra: string };

function toBookmark(row: Row): Bookmark {
  const { tags_json, extra, ...rest } = row;
  let parsedExtra: Record<string, unknown> = {};
  try {
    parsedExtra = JSON.parse(extra || '{}');
  } catch {
    // extra 壞掉不影響書籤本身
  }
  return { ...rest, tags: tags_json ? (JSON.parse(tags_json) as string[]) : [], extra: parsedExtra };
}

/** 去掉 #、壓空白、限制長度，不分大小寫去重 */
export function normalizeTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,，、]/) : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const tag = item.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

export interface BookmarkInput {
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
}

export async function getBookmark(db: D1Database, id: number): Promise<Bookmark | null> {
  const row = await db.prepare(`${SELECT_BOOKMARK} WHERE b.id = ?`).bind(id).first<Row>();
  return row ? toBookmark(row) : null;
}

export async function findIdByUrl(db: D1Database, url: string): Promise<number | null> {
  const row = await db.prepare('SELECT id FROM bookmarks WHERE url = ?').bind(url).first<{ id: number }>();
  return row?.id ?? null;
}

export async function insertBookmark(db: D1Database, input: BookmarkInput): Promise<Bookmark> {
  const now = new Date().toISOString();
  // 標籤用 url 找回新 id，與主表寫入放在同一個 batch（同一個交易）
  const statements = [
    db
      .prepare(
        `INSERT INTO bookmarks (url, title, summary, category, note, thumbnail, favicon, site, host, extra, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.url, input.title, input.summary, input.category, input.note, input.thumbnail, input.favicon,
        input.site, input.host, JSON.stringify(input.extra), now, now),
    ...input.tags.map((tag) =>
      db.prepare('INSERT INTO bookmark_tags (bookmark_id, tag) SELECT id, ? FROM bookmarks WHERE url = ?').bind(tag, input.url),
    ),
  ];
  await db.batch(statements);
  const id = await findIdByUrl(db, input.url);
  return (await getBookmark(db, id!))!;
}

const EDITABLE = ['title', 'summary', 'category', 'note', 'thumbnail'] as const;
export type BookmarkPatch = Partial<Pick<BookmarkInput, (typeof EDITABLE)[number] | 'tags'>>;

export async function updateBookmark(db: D1Database, id: number, patch: BookmarkPatch): Promise<Bookmark | null> {
  const fields = EDITABLE.filter((key) => patch[key] !== undefined);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE bookmarks SET ${fields.map((f) => `${f} = ?, `).join('')}updated_at = ? WHERE id = ?`)
      .bind(...fields.map((f) => patch[f]!), new Date().toISOString(), id),
  ];
  if (patch.tags) {
    statements.push(db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').bind(id));
    for (const tag of patch.tags) {
      statements.push(db.prepare('INSERT INTO bookmark_tags (bookmark_id, tag) SELECT id, ? FROM bookmarks WHERE id = ?').bind(tag, id));
    }
  }
  await db.batch(statements);
  return getBookmark(db, id);
}

export async function deleteBookmark(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').bind(id),
    db.prepare('DELETE FROM bookmarks WHERE id = ?').bind(id),
  ]);
}

/** 點擊數加一並回傳網址；書籤不存在時回傳 null */
export async function recordClick(db: D1Database, id: number): Promise<string | null> {
  const row = await db
    .prepare('UPDATE bookmarks SET click_count = click_count + 1, last_clicked_at = ? WHERE id = ? RETURNING url')
    .bind(new Date().toISOString(), id)
    .first<{ url: string }>();
  return row?.url ?? null;
}

export interface ListQuery {
  q?: string;
  site?: string;
  tag?: string;
  category?: string;
  sort?: string;
  limit: number;
  offset: number;
}

const SORTS: Record<string, string> = {
  created: 'b.created_at DESC, b.id DESC',
  clicked: 'b.last_clicked_at DESC, b.id DESC',
  popular: 'b.click_count DESC, b.id DESC',
};

/**
 * 搜尋標題、摘要、備註、網址、分類與標籤，多個關鍵字取交集。
 * 用 instr() 而不是 LIKE：D1 的 LIKE pattern 上限 50 bytes，中文一字 3 bytes 很快就超過。
 */
export async function listBookmarks(db: D1Database, query: ListQuery): Promise<{ items: Bookmark[]; hasMore: boolean }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `?${params.length}`;
  };

  const tokens = (query.q ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TOKENS)
    .map((t) => t.slice(0, 100));
  for (const token of tokens) {
    const p = param(token);
    where.push(`(instr(lower(b.title), ${p}) > 0 OR instr(lower(b.summary), ${p}) > 0 OR instr(lower(b.note), ${p}) > 0
      OR instr(lower(b.url), ${p}) > 0 OR instr(lower(b.category), ${p}) > 0
      OR EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.bookmark_id = b.id AND instr(lower(t.tag), ${p}) > 0))`);
  }
  if (query.site) where.push(`b.site = ${param(query.site)}`);
  if (query.category) where.push(`b.category = ${param(query.category)}`);
  if (query.tag) where.push(`EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.bookmark_id = b.id AND t.tag = ${param(query.tag)})`);
  if (query.sort === 'clicked') where.push('b.last_clicked_at IS NOT NULL');

  const order = SORTS[query.sort ?? ''] ?? SORTS.created;
  // 多取一筆判斷是否還有下一頁
  const sql = `${SELECT_BOOKMARK} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${order} LIMIT ${param(query.limit + 1)} OFFSET ${param(query.offset)}`;
  const { results } = await db.prepare(sql).bind(...params).all<Row>();
  return { items: results.slice(0, query.limit).map(toBookmark), hasMore: results.length > query.limit };
}

export interface Overview {
  total: number;
  recent: Bookmark[];
  clicked: Bookmark[];
  sites: { name: string; count: number }[];
  categories: { name: string; count: number }[];
  tags: { name: string; count: number }[];
}

export async function getOverview(db: D1Database, size = 8): Promise<Overview> {
  const [total, recent, clicked, sites, categories, tags] = await db.batch([
    db.prepare('SELECT COUNT(*) AS count FROM bookmarks'),
    db.prepare(`${SELECT_BOOKMARK} ORDER BY b.created_at DESC, b.id DESC LIMIT ?`).bind(size),
    db.prepare(`${SELECT_BOOKMARK} WHERE b.last_clicked_at IS NOT NULL ORDER BY b.last_clicked_at DESC, b.id DESC LIMIT ?`).bind(size),
    db.prepare(`SELECT site AS name, COUNT(*) AS count FROM bookmarks WHERE site != '' GROUP BY site ORDER BY count DESC, name`),
    db.prepare(`SELECT category AS name, COUNT(*) AS count FROM bookmarks WHERE category != '' GROUP BY category ORDER BY count DESC, name`),
    db.prepare('SELECT tag AS name, COUNT(*) AS count FROM bookmark_tags GROUP BY tag ORDER BY count DESC, name LIMIT 80'),
  ]);
  return {
    total: (total.results[0] as { count: number }).count,
    recent: (recent.results as Row[]).map(toBookmark),
    clicked: (clicked.results as Row[]).map(toBookmark),
    sites: sites.results as Overview['sites'],
    categories: categories.results as Overview['categories'],
    tags: tags.results as Overview['tags'],
  };
}

/** 給 AI 參考的既有分類與常用標籤，讓新書籤沿用同一套命名 */
export async function getVocabulary(db: D1Database): Promise<{ categories: string[]; tags: string[] }> {
  const [categories, tags] = await db.batch<{ name: string }>([
    db.prepare(`SELECT category AS name FROM bookmarks WHERE category != '' GROUP BY category ORDER BY COUNT(*) DESC LIMIT 30`),
    db.prepare('SELECT tag AS name FROM bookmark_tags GROUP BY tag ORDER BY COUNT(*) DESC LIMIT 50'),
  ]);
  return { categories: categories.results.map((r) => r.name), tags: tags.results.map((r) => r.name) };
}
