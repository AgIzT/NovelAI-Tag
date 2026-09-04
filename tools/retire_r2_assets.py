# -*- coding: utf-8 -*-
"""按下架报告处置 R2 上的图片对象，默认预演。

`sync_r2.py` 只上传不删除，所以下架后的 R2 侧收尾走这里。名单**只来自
`takedown_pack_entries.py` 写出的 takedown.json**，逐个精确 key 操作，
绝不按目录通配 —— 这条边界见 ``docs/运维/恶意标签元数据应急下线.md``。

两种模式：
  retire（默认）保留字节、销毁公开地址：把本地留档上传到 ``retired/<sha256><ext>``
              这个不可枚举的新 key，验证成功后再删原 key。老直链 404，图还在 R2。
  delete      只删原 key，不留 R2 副本（本地留档仍在报告目录里）。

⚠ 当前 --apply 被代码门禁锁死。只有历史 release / 激活隔离、clean rollback、
   失败恢复与逐次授权门都实现并通过验收后，才能由受审变更解除。

用法：
  python tools/retire_r2_assets.py --report output/takedown-<戳>-<book>/takedown.json
  # 当前 --apply 被门禁锁死，只能执行上一行的只读远端预演。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from .sync_r2 import R2Client, load_config, request_config
except ImportError:
    from sync_r2 import R2Client, load_config, request_config

ROOT = Path(__file__).resolve().parents[1]
RETIRED_PREFIX = "retired"
# 退役对象即使被猜到也别让边缘缓存留副本。
RETIRED_CACHE_CONTROL = "private, max-age=0, no-store"
APPLY_BLOCKED_REASON = (
    "--apply 尚未开放：历史 release / 激活隔离、clean rollback、失败恢复与逐次授权门禁"
    "仍未闭合；当前只能执行带鉴权的只读 HEAD 预演"
)


def retired_key(sha256: str, source_key: str) -> str:
    suffix = Path(source_key).suffix.lower()
    return f"{RETIRED_PREFIX}/{sha256}{suffix}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--report", required=True, help="takedown.json 路径")
    parser.add_argument("--mode", choices=("retire", "delete"), default="retire")
    parser.add_argument("--apply", action="store_true", help="真正动 R2；默认只预演")
    parser.add_argument("--request-timeout", type=float, default=None)
    parser.add_argument("--request-retries", type=int, default=None)
    parser.add_argument("--retry-base-delay", type=float, default=None)
    args = parser.parse_args(argv)

    if args.apply:
        print(f"FAIL: {APPLY_BLOCKED_REASON}")
        return 2

    report_path = Path(args.report)
    if not report_path.is_absolute():
        report_path = ROOT / report_path
    if not report_path.is_file():
        print(f"FAIL: missing report {report_path}")
        return 2
    report = json.loads(report_path.read_bytes().decode("utf-8"))
    assets = report.get("assets") or []
    if not assets:
        print("FAIL: report has no assets")
        return 2

    cfg = load_config(required=True)
    client = R2Client(request_config(cfg, args))

    plan = []
    for asset in assets:
        key = str(asset.get("r2Key") or "")
        sha = str(asset.get("sha256") or "")
        local = ROOT / str(asset.get("local") or "")
        if not key or not sha:
            print(f"FAIL: report row missing r2Key/sha256: {asset}")
            return 2
        status, _headers, _body = client.head(key)
        row = {
            "r2Key": key,
            "sha256": sha,
            "local": local,
            "localExists": local.is_file(),
            "remoteStatus": status,
            "retiredKey": retired_key(sha, key) if args.mode == "retire" else "",
        }
        plan.append(row)

    print(f"report: {report_path.relative_to(ROOT).as_posix()}")
    print(f"mode: {args.mode} | assets: {len(plan)}")
    for row in plan:
        state = "存在" if row["remoteStatus"] == 200 else f"HEAD {row['remoteStatus']}"
        line = f"  - {row['r2Key']}  远端{state}"
        if args.mode == "retire":
            line += f"  ->  {row['retiredKey']}  本地{'有' if row['localExists'] else '缺'}留档"
        print(line)

    if args.mode == "retire":
        blocked = [r for r in plan if r["remoteStatus"] == 200 and not r["localExists"]]
        if blocked:
            print(f"FAIL: {len(blocked)} 个对象没有本地留档，retire 会把字节弄丢；先补留档或改 --mode delete")
            return 2

    if not args.apply:
        print("plan only; pass --apply to touch R2")
        return 0

    results = []
    for row in plan:
        key = row["r2Key"]
        if row["remoteStatus"] != 200:
            print(f"skip (远端已不存在): {key}")
            results.append({"r2Key": key, "action": "skip", "reason": f"head {row['remoteStatus']}"})
            continue

        if args.mode == "retire":
            new_key = row["retiredKey"]
            status, _headers, body = client.put_file(new_key, row["local"], row["sha256"], RETIRED_CACHE_CONTROL)
            if status not in (200, 201):
                print(f"FAIL: 上传 {new_key} 返回 {status}；原 key 保持不动")
                print(f"  {body[:300]!r}")
                return 2
            verify, _h, _b = client.head(new_key)
            if verify != 200:
                print(f"FAIL: {new_key} 上传后 HEAD {verify}；原 key 保持不动")
                return 2

        status, _headers, body = client._request("DELETE", key)
        if status not in (200, 204):
            print(f"FAIL: 删除 {key} 返回 {status}")
            print(f"  {body[:300]!r}")
            return 2
        after, _h, _b = client.head(key)
        if after != 404:
            print(f"FAIL: {key} 删除后 HEAD {after}（应为 404）")
            return 2

        row_result = {"r2Key": key, "action": args.mode, "deleted": True}
        if args.mode == "retire":
            row_result["retiredKey"] = row["retiredKey"]
        results.append(row_result)
        print(f"done: {key} -> {row_result.get('retiredKey') or '已删除'}")

    out_path = report_path.with_name(f"r2-{args.mode}-result.json")
    out_path.write_text(
        json.dumps({"mode": args.mode, "results": results}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"result: {out_path.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
