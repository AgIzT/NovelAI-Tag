-- 所长生日「送上祝福」计数：只按年与 UTC 日累计次数，不存访客、设备或会话标识。
-- 独立于 site_metric_*：本机统计更新器遇到未知事件名会报错，祝福也不该占产品统计的限额。
CREATE TABLE birthday_wishes (
  year TEXT NOT NULL,
  day TEXT NOT NULL,
  wish_count INTEGER NOT NULL CHECK (wish_count > 0),
  PRIMARY KEY (year, day)
) WITHOUT ROWID;

-- 分钟限额桶：bucket 为 'all'（全站请求数）或加盐 IP 摘要（该 IP 的祝福数），两分钟后过期。
CREATE TABLE birthday_wish_rate (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
) WITHOUT ROWID;
CREATE INDEX birthday_wish_rate_expiry ON birthday_wish_rate (expires_at);
