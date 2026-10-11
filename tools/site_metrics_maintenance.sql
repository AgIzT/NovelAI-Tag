-- MUTATING maintenance, local by default in documented commands.
-- Remote execution requires separate authorization. Never clear community tables.
DELETE FROM site_metric_counts WHERE day < date('now', '-89 days');
DELETE FROM site_metric_rate WHERE expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;
