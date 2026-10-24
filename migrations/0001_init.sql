-- 書籤主表
CREATE TABLE bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  favicon TEXT NOT NULL DEFAULT '',
  -- 網站分類（GitHub、Threads……），由網域對照表決定
  site TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  -- 網域擴充器產生的額外資訊（JSON），例如 GitHub 的 stars、language
  extra TEXT NOT NULL DEFAULT '{}',
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_clicked_at TEXT
);

CREATE INDEX idx_bookmarks_created ON bookmarks (created_at DESC, id DESC);
CREATE INDEX idx_bookmarks_clicked ON bookmarks (last_clicked_at DESC, id DESC) WHERE last_clicked_at IS NOT NULL;
CREATE INDEX idx_bookmarks_site ON bookmarks (site);
CREATE INDEX idx_bookmarks_category ON bookmarks (category);

-- 標籤：一筆書籤多個標籤，獨立成表方便依數量排序
CREATE TABLE bookmark_tags (
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (bookmark_id, tag)
);

CREATE INDEX idx_bookmark_tags_tag ON bookmark_tags (tag);

-- 對外 webhook：事件發生時依 method 呼叫 url
CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  -- bookmark.created / bookmark.updated / bookmark.deleted / bookmark.clicked / *
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'POST_JSON' CHECK (method IN ('GET', 'POST_JSON', 'POST_FORM')),
  -- 有值時以 HMAC-SHA256 簽章，放在 X-Bookmark-Signature
  secret TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status TEXT NOT NULL DEFAULT '',
  last_called_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_webhooks_event ON webhooks (event, enabled);
