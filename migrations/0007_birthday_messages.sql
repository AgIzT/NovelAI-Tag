-- 所长生日祝福墙：先审后发。只存留言文字、可选署名、审核状态与时间，不存访客、设备或 IP。
-- 限额沿用 0006 的 birthday_wish_rate（bucket 以 msg: 开头）。
CREATE TABLE birthday_messages (
  id TEXT PRIMARY KEY,
  year TEXT NOT NULL,
  body TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  body_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'held', 'rejected', 'hidden')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT CHECK (decided_by IS NULL OR decided_by IN ('agent', 'admin'))
) WITHOUT ROWID;
CREATE INDEX birthday_messages_status_idx ON birthday_messages (year, status, decided_at);
-- 同一年同样的话只收一条（body_key 是去掉空白与标点、转小写后的正文）
CREATE UNIQUE INDEX birthday_messages_key_idx ON birthday_messages (year, body_key);

-- 祝福墙总开关：key='wall'，value 'on' / 'off'；没有这一行视为开
CREATE TABLE birthday_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
