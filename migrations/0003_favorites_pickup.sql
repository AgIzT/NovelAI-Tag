-- 收藏取件码：迁移文本在服务端暂存 10 分钟，取用一次即删除；库里只存取件码的 SHA-256。
-- payload 可达约 1 MB，使用普通 rowid 表，不用 WITHOUT ROWID。
CREATE TABLE IF NOT EXISTS favorites_pickups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (bytes > 0)
);

CREATE INDEX IF NOT EXISTS favorites_pickups_expiry_idx
  ON favorites_pickups (expires_at);

CREATE TABLE IF NOT EXISTS pickup_rate_buckets (
  action TEXT NOT NULL,
  identifier_hash TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (action, identifier_hash, bucket_start),
  CHECK (action IN ('create', 'redeem')),
  CHECK (request_count >= 0)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS pickup_rate_buckets_expiry_idx
  ON pickup_rate_buckets (expires_at);
