// 速率限制：同一種操作兩次之間至少隔多久。全站共用一組名額，不分呼叫來源（瀏覽器、應用程式帳密、MCP 閘道）

/** 最短間隔（毫秒），0 是不限制。改完重新部署才生效 */
export const RATE_LIMITS = {
  /** 抓取網頁並產生草稿，可能呼叫 Workers AI：預覽、只給網址的新增 */
  draft: 1000,
  /** 書籤的新增、更新、刪除 */
  write: 1000,
};

export type RateBucket = keyof typeof RATE_LIMITS;

// 選用：設為 false 時整個關掉，給連續寫入的自動化測試用（例如 MCP 閘道把這個 Worker 掛成 auxiliary worker）
declare global {
  interface Env {
    RATE_LIMIT_ENABLED?: string;
  }
}

export class RateLimitError extends Error {
  /** retryAfter：幾秒後可以再試 */
  constructor(readonly retryAfter: number) {
    super(`操作太頻繁，請 ${retryAfter} 秒後再試`);
  }
}

/**
 * 佔用一次名額；還在間隔內就丟 RateLimitError。
 * 時間戳放 D1，以條件式寫入判斷：同時進來的請求只有一個改得到，不會都放行
 */
export async function takeSlot(env: Env, bucket: RateBucket): Promise<void> {
  const interval = RATE_LIMITS[bucket];
  if (interval <= 0 || env.RATE_LIMIT_ENABLED === 'false') return;
  const now = Date.now();
  // last_at > 現在：時鐘曾經往回調，照樣放行，免得卡到那個時間點
  const { meta } = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, last_at) VALUES (?1, ?2)
     ON CONFLICT (bucket) DO UPDATE SET last_at = excluded.last_at
     WHERE rate_limits.last_at <= ?3 OR rate_limits.last_at > ?2`,
  )
    .bind(bucket, now, now - interval)
    .run();
  if (meta.changes !== 1) throw new RateLimitError(Math.ceil(interval / 1000));
}
