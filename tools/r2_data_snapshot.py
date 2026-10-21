"""Freeze the input bytes before a multi-format publication."""
from contextlib import contextmanager
import os
from pathlib import Path
import stat
import tempfile

try:
    from . import r2_data_protocol as cas
except ImportError:
    import r2_data_protocol as cas

ROOT = Path(__file__).resolve().parents[1]


def no_links(path):
    for part in (Path(path).absolute(), *Path(path).absolute().parents):
        if part.exists() or part.is_symlink():
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("snapshot paths cannot contain links or reparse points")


def source_files(directory):
    paths = {}
    for parent, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            no_links(Path(parent) / name)
        for name in files:
            if name.endswith(".json"):
                path = Path(parent) / name
                paths[path.relative_to(directory).as_posix()] = path
    return dict(sorted(paths.items()))


@contextmanager
def frozen_data_directory(data_dir):
    source = Path(data_dir).absolute()
    no_links(source)
    if not source.is_dir():
        raise ValueError("data directory is missing")
    paths = source_files(source)
    if not paths:
        raise ValueError("data directory contains no JSON")
    before = {name: (path.stat().st_size, path.stat().st_mtime_ns) for name, path in paths.items()}
    parent = ROOT / "output" / "r2-publish-staging"
    no_links(parent)
    parent.mkdir(parents=True, exist_ok=True)
    no_links(parent)
    with tempfile.TemporaryDirectory(prefix="snapshot-", dir=parent) as temporary:
        snapshot = Path(temporary)
        # Verified before TemporaryDirectory cleanup: the target is a fresh child of project output.
        if snapshot.resolve().parent != parent.resolve():
            raise ValueError("snapshot escaped staging root")
        digests = {}
        for name, path in paths.items():
            body = path.read_bytes()
            cas.parse_json(body)
            digests[name] = cas.sha256(body)
            target = snapshot / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(body)
        if set(source_files(source)) != set(paths):
            raise RuntimeError("source file collection changed during snapshot")
        for name, path in paths.items():
            current = path.stat()
            if (current.st_size, current.st_mtime_ns) != before[name] or cas.sha256(path.read_bytes()) != digests[name]:
                raise RuntimeError("source file changed during snapshot")
        yield snapshot
