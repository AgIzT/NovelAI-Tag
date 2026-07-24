# -*- coding: utf-8 -*-
"""按保留策略清理 output/ 目录（默认 dry-run，--apply 才真删）。

保留策略（2026-07-24 与维护者商定）：
  1. output/ui-regression/<时间戳>/ ：只保留最近 KEEP_UI_REGRESSION 次，更早的删除。
  2. output/ 顶层形如 <家族名>_YYYYMMDD-HHMMSS 的时间戳报告目录：每个家族只保留最新一份。
  3. output/ 顶层散落的 *.log / *.out.log / *.err.log / *.stderr.log / *.stdout.log 文件：删除。
  4. output/edit-backups/<时间戳>/（法典编辑器写前快照）：只保留最近 KEEP_EDIT_BACKUPS 份。
  5. 其余一律不动（白名单式：不匹配上述模式的目录/文件永不删除）。
     例如 nai-api-fill/、feedback-public-consent-migration-*/（回滚备份）天然不匹配，安全。

用法：
  python tools/cleanup_output.py            # 只打印将删除什么、能回收多少
  python tools/cleanup_output.py --apply    # 实际删除
"""
from __future__ import annotations

import argparse
import re
import shutil
import stat
import sys
from pathlib import Path

KEEP_UI_REGRESSION = 5
KEEP_EDIT_BACKUPS = 50
TS_DIR_RE = re.compile(r"^(?P<family>.+)_(?P<ts>\d{8}-\d{6})$")
UI_TS_RE = re.compile(r"^\d{8}-\d{6}$")
EDIT_BACKUP_RE = re.compile(r"^\d{8}-\d{6}(-\d+)?$")
LOG_SUFFIXES = (".log",)

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "output"


def dir_size(path: Path) -> int:
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            pass
    return total


def _on_rm_error(func, path, exc_info):
    # Windows 只读文件：去只读位再重试
    try:
        Path(path).chmod(stat.S_IWRITE)
        func(path)
    except OSError:
        raise


def collect_targets() -> list[Path]:
    targets: list[Path] = []

    ui_dir = OUTPUT / "ui-regression"
    if ui_dir.is_dir():
        runs = sorted(d for d in ui_dir.iterdir() if d.is_dir() and UI_TS_RE.match(d.name))
        targets.extend(runs[:-KEEP_UI_REGRESSION] if len(runs) > KEEP_UI_REGRESSION else [])

    backup_dir = OUTPUT / "edit-backups"
    if backup_dir.is_dir():
        snaps = sorted(d for d in backup_dir.iterdir() if d.is_dir() and EDIT_BACKUP_RE.match(d.name))
        targets.extend(snaps[:-KEEP_EDIT_BACKUPS] if len(snaps) > KEEP_EDIT_BACKUPS else [])

    families: dict[str, list[Path]] = {}
    for d in OUTPUT.iterdir():
        if d.is_dir():
            m = TS_DIR_RE.match(d.name)
            if m:
                families.setdefault(m.group("family"), []).append(d)
    for dirs in families.values():
        dirs.sort(key=lambda p: p.name)
        targets.extend(dirs[:-1])  # 每族留最新一份

    for f in OUTPUT.iterdir():
        if f.is_file() and f.name.lower().endswith(LOG_SUFFIXES):
            targets.append(f)

    return targets


def main() -> int:
    parser = argparse.ArgumentParser(description="Clean output/ per retention policy")
    parser.add_argument("--apply", action="store_true", help="actually delete (default: dry-run)")
    args = parser.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

    if not OUTPUT.is_dir():
        print(f"output dir not found: {OUTPUT}")
        return 1

    targets = collect_targets()
    if not targets:
        print("Nothing to clean. output/ already satisfies the retention policy.")
        return 0

    total = 0
    for t in sorted(targets):
        size = dir_size(t) if t.is_dir() else t.stat().st_size
        total += size
        kind = "DIR " if t.is_dir() else "FILE"
        print(f"  {kind} {size / 1024 / 1024:9.1f} MB  {t.relative_to(OUTPUT)}")

    print(f"\n{len(targets)} items, {total / 1024 / 1024 / 1024:.2f} GB reclaimable.")

    if not args.apply:
        print("Dry-run only. Re-run with --apply to delete.")
        return 0

    failed = 0
    for t in targets:
        try:
            if t.is_dir():
                shutil.rmtree(t, onerror=_on_rm_error)
            else:
                t.unlink()
        except OSError as e:
            failed += 1
            print(f"FAILED: {t} ({e})")
    print(f"Deleted {len(targets) - failed} items" + (f", {failed} failed." if failed else "."))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
