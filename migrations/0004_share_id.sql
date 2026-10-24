-- 中轉頁的網址 /b/<share_id>，未登入也能瀏覽。用不可猜的亂數，不用遞增的 id：否則任何人都能逐號列舉全部書籤
ALTER TABLE bookmarks ADD COLUMN share_id TEXT;

-- randomblob() 每列各算一次，既有書籤各拿到不同的值
UPDATE bookmarks SET share_id = lower(hex(randomblob(12))) WHERE share_id IS NULL;

CREATE UNIQUE INDEX idx_bookmarks_share ON bookmarks (share_id);
