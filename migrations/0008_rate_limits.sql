-- 速率限制：每種操作（bucket）上一次放行的時間（毫秒）。間隔寫在 src/ratelimit.ts
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL
);
