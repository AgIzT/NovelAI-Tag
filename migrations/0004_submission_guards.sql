-- 投稿 / 反馈的防刷限额与待审容量保险丝：判断和计数放在同一个 D1 事务里，同时到达的请求不会一起放行。
-- 来源只存摘要；过期行在每次调用时顺带删除，不需要另外的清理任务。
CREATE TABLE IF NOT EXISTS submission_rate_buckets (
  scope TEXT NOT NULL,
  identifier_hash TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, identifier_hash, bucket_start),
  CHECK (scope IN ('feedback')),
  CHECK (request_count >= 0)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS submission_rate_buckets_expiry_idx
  ON submission_rate_buckets (expires_at);

-- 写入 R2 待审区之前先在这里占一个名额。名额保留到过期，不随写入完成立即释放：
-- 这样「R2 里已有的条数 + 未过期名额」在任何时刻都不会漏算刚写进去的记录，代价是写入后几分钟内会多算一次。
CREATE TABLE IF NOT EXISTS pending_reservations (
  queue TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (queue, reservation_id),
  CHECK (queue IN ('community', 'feedback'))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS pending_reservations_queue_idx
  ON pending_reservations (queue, expires_at);
