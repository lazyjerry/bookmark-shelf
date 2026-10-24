-- 應用程式帳密的呼叫紀錄。每組帳密各自設定保留天數與筆數（預設 7 天、700 筆，上限 30 天、10000 筆），超過的在寫入時清掉
ALTER TABLE app_credentials ADD COLUMN log_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE app_credentials ADD COLUMN log_limit INTEGER NOT NULL DEFAULT 700;

CREATE TABLE app_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  method TEXT NOT NULL,
  -- 含查詢字串
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  -- 操作到的書籤；新增時取自回應
  bookmark_id INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_app_logs_app ON app_logs (app_id, id);
