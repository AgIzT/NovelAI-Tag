"""Small local-tool write guard: durable before-images and exception compensation.

This is not a power-loss-safe multi-file transaction. The manifest and untouched
before-images remain available for manual recovery after process termination.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import uuid


class TransactionError(OSError):
    def __init__(self, message, backup_dir, rollback_errors=()):
        self.backup_dir = backup_dir
        self.rollback_errors = list(rollback_errors)
        super().__init__(message)


def atomic_write_bytes(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _checked_path(root, path):
    target = Path(os.path.abspath(path))
    target.relative_to(root)
    for part in (target, *target.parents):
        if part.exists() or part.is_symlink():
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("local transaction paths cannot contain links or reparse points")
        if part == root:
            break
    if target == root:
        raise ValueError("transaction target must be a file below root")
    return target


def run_file_transaction(root, paths, operation, family):
    """Call operation after a complete backup; restore exact prior bytes on error.

    Callers hold their existing write lock over validation, snapshot and commit.
    paths includes absent targets, so compensation can also remove newly created
    files. Neither successful commits nor rollback failures delete backups.
    """
    root = Path(os.path.abspath(root))
    states = {}
    for raw in paths:
        path = _checked_path(root, raw)
        states[path] = path.read_bytes() if path.exists() else None
    backup = root / "output" / "local-tool-backups" / (family + "-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex)
    _checked_path(root, backup)
    backup.mkdir(parents=True)
    relative_backup = backup.relative_to(root).as_posix()
    manifest = {"schema": 1, "family": family, "files": []}
    for path, before in states.items():
        relative = path.relative_to(root).as_posix()
        item = {"path": relative, "existed": before is not None}
        if before is not None:
            saved = backup / "files" / relative
            atomic_write_bytes(saved, before)
            item.update({"backup": "files/" + relative, "size": len(before),
                         "sha256": hashlib.sha256(before).hexdigest()})
        manifest["files"].append(item)
    atomic_write_bytes(backup / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
    try:
        value = operation()
    except Exception as original:
        errors = []
        for path, before in reversed(list(states.items())):
            try:
                _checked_path(root, path)
                if before is None:
                    if path.exists():
                        path.unlink()
                elif not path.exists() or path.read_bytes() != before:
                    atomic_write_bytes(path, before)
            except Exception as error:
                errors.append(f"{path.relative_to(root).as_posix()}: {error}")
        state = "自动恢复未完成" if errors else "已恢复修改前文件"
        raise TransactionError(f"写入失败，{state}；备份：{relative_backup}；{original}", relative_backup, errors) from original
    return value, relative_backup
