"""Explicit local-only adapter for the real publisher; no credentials or network."""
from pathlib import Path

try:
    from . import r2_data_protocol as cas
    from .r2_cas_experiment.store import SQLiteStore, PreconditionFailed
    from .r2_cas_experiment.publisher import safe_output
except ImportError:
    import r2_data_protocol as cas
    from r2_cas_experiment.store import SQLiteStore, PreconditionFailed
    from r2_cas_experiment.publisher import safe_output


class LocalDataClient:
    def __init__(self, directory):
        self.store = SQLiteStore(safe_output(Path(directory)))
        self.operations = []
        self.retries = 0
        self.retry_base_delay = 0

    def head_metadata(self, key):
        record = self.store.get(key)
        return {"size": len(record.body), **record.metadata} if record else None

    def get_bytes(self, key):
        record = self.store.get(key)
        return record.body if record else None

    def get_json_snapshot(self, key):
        record = self.store.get(key)
        return (cas.parse_json(record.body), record.etag) if record else (None, None)

    def get_json(self, key):
        return self.get_json_snapshot(key)[0]

    def _metadata(self, body, cache_control, content_type=cas.JSON_TYPE):
        return {"sha256": cas.sha256(body), "content_type": content_type, "cache_control": cache_control}

    def _legacy_write(self, kind, key, body, cache_control, content_type=cas.JSON_TYPE):
        old = self.store.get(key)
        meta = self._metadata(body, cache_control, content_type)
        if old:
            self.store.put(key, body, meta, old.etag)
        else:
            self.store.create(key, body, meta)
        self.operations.append((kind, key))

    def put_file(self, key, item, cache_control):
        body = item.path.read_bytes()
        if cas.sha256(body) != item.sha256:
            raise RuntimeError("file changed during upload")
        self._legacy_write("file", key, body, cache_control, "application/json")

    def copy_file(self, source_key, key, item, cache_control):
        body = self.get_bytes(source_key)
        if body is None or cas.sha256(body) != item.sha256:
            raise RuntimeError("local copy source differs")
        self._legacy_write("copy", key, body, cache_control, "application/json")

    def put_bytes(self, key, body, cache_control):
        self._legacy_write("bytes", key, body, cache_control)

    def create_bytes(self, key, body, cache_control):
        try:
            self.store.create(key, body, self._metadata(body, cache_control))
        except PreconditionFailed:
            return 412
        self.operations.append(("create", key))
        return 200

    def put_pointer(self, key, body, expected_etag):
        try:
            self.store.put(key, body, self._metadata(body, "no-store"), expected_etag)
        except PreconditionFailed as ex:
            raise RuntimeError("current pointer conflict") from ex
        except Exception as ex:
            raise RuntimeError("current pointer write outcome unknown") from ex
        self.operations.append(("pointer", key))

    def close(self):
        pass
