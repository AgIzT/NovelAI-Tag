# -*- coding: utf-8 -*-
"""文档体检 —— 把「机器能查的」从人工规整里摘出来。

用法（仓库根目录）：
    python tools/lint_docs.py                 # 体检，报告写 output/docs-lint-report.txt
    python tools/lint_docs.py --print         # 顺便把报告打到 stdout（可能有 GBK 乱码，慎用）

⚠ 控制台 GBK：本脚本**只把中文写进 UTF-8 报告文件**，stdout 只输出 ASCII 计数，
   遵守 AGENTS.md「别直接 print 中文到 stdout」。

退出码：0 = 无 ERROR；1 = 有 ERROR。WARN 不影响退出码（需要人判断的都算 WARN）。

配套：`docs/经验/文档规整.md` 是完整的定期规整流程，本脚本是其中「1.1 机器可验证项」那一步。
姊妹脚本 `tools/lint_data.py`（数据体检）尚未落地，见 docs/roadmap.md「统一数据体检」。
"""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORT = os.path.join(ROOT, 'output', 'docs-lint-report.txt')
WORKSPACE = os.path.dirname(ROOT)                       # D:\program\NOVEL
LAUNCH = os.path.join(WORKSPACE, '.claude', 'launch.json')

# ── 分区 ────────────────────────────────────────────────────────────────
# 只读区：编年史与「当时为什么」。里面的旧数字/旧端口是史实，不参与现状类检查。
READONLY_PREFIXES = ('docs/日志/', 'docs/decisions/')
# 带索引的目录：README.md 必须收全同目录 md
INDEXED_DIRS = ('docs/decisions', 'docs/经验', 'docs/运维')
# always-loaded / 开工必读 的字节预算
BUDGET = {'AGENTS.md': 18000, 'CLAUDE.md': 6000, 'HANDOFF.md': 12288}
# 巨型文件阈值（超过就该只 Grep 不整读）
HUGE = 40000
# 篇幅提醒（AGENTS.md「文档读取路由」；超出只报 WARN，由人判断）
INDEX_ENTRY_AVG = 300          # 索引平均每条字节
INDEX_ENTRY_MAX = 450          # 单条明显超长时点名
HANDOFF_ITEM_MAX = 400         # HANDOFF 每条字节
LOG_ENTRY_MAX = 1536           # 新日志条目字节
LOG_RULE_SINCE = '2026-11-17'  # 只查这天及以后的新条目，旧日志是史实不动

errors: list[str] = []
warns: list[str] = []
notes: list[str] = []


def rel(p: str) -> str:
    return os.path.relpath(p, ROOT).replace('\\', '/')


def all_md() -> list[str]:
    out = []
    skip = ('.git', 'node_modules', 'output', 'originals', '.wrangler',
            '.playwright-cli', '法典源', '法典源_已转换', '.tmp')
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in skip]
        for f in files:
            if f.endswith('.md'):
                out.append(rel(os.path.join(base, f)))
    return sorted(out)


def read(p: str) -> str:
    with open(os.path.join(ROOT, p), encoding='utf-8', errors='replace') as fh:
        return fh.read()


def read_abs(path: str) -> str:
    with open(path, encoding='utf-8', errors='replace') as fh:
        return fh.read()


def fsize(p: str) -> int:
    return os.path.getsize(os.path.join(ROOT, p))


def nbytes(s: str) -> int:
    return len(s.encode('utf-8'))


def is_readonly(p: str) -> bool:
    return p.startswith(READONLY_PREFIXES)


# ── 1. 索引完整性 ───────────────────────────────────────────────────────
def check_indexes():
    for d in INDEXED_DIRS:
        idx_path = f'{d}/README.md'
        if not os.path.exists(os.path.join(ROOT, idx_path)):
            errors.append(f'[索引] {d}/ 没有 README.md 索引——AI 无法按需命中这个目录')
            continue
        idx = read(idx_path)
        for f in sorted(os.listdir(os.path.join(ROOT, d))):
            if f.endswith('.md') and f != 'README.md' and f not in idx:
                errors.append(f'[索引] {d}/{f} 没有出现在 {idx_path} 里——它永远不会被加载')
        for link in sorted(set(re.findall(r'\[`?([^\]`|]+?\.md)`?\]', idx))):
            if link.startswith('<'):
                continue
            target = os.path.normpath(os.path.join(ROOT, d, link))
            if not os.path.exists(target):
                errors.append(f'[索引] {idx_path} 指向不存在的文件：{link}')
        # 表格式索引的链接文字是篇名，要按 (目标) 再查一遍
        for target in sorted(markdown_link_targets(idx_path, idx)):
            if '<' in target:
                continue      # 模板注释里的 `<文件名>.md` 占位符
            if not os.path.exists(os.path.join(ROOT, target)):
                errors.append(f'[索引] {idx_path} 链接到不存在的文件：{target}')


# ── 2. 死链 ─────────────────────────────────────────────────────────────
def check_deadlinks(mds):
    for m in mds:
        if m.startswith('docs/日志/'):
            continue          # 编年史会提到当时的文件名，属史实，不算死链
        t = read(m)
        for link in sorted(set(re.findall(r'`(docs/[^\s`)\]，。、；;]+\.md)`', t))):
            if '<' in link:
                continue      # `docs/日志/<当月>.md` 这类占位符
            if not os.path.exists(os.path.join(ROOT, link)):
                errors.append(f'[死链] {m} → {link}')


# ── 3. 被文档提到的脚本 / bat / 模块是否存在 ────────────────────────────
# 这些词出现在同一行 → 这条引用讲的是「还没做」或「已经删了」，不是现状断言
_PLANNED = ('候选', '建议', '计划', '打算', '将来', '未来', '待做', '尚未', '还没', '推荐',
            '已删除', '已废', '不存在', '别再', '禁止', '曾', '原', '旧')
# 整篇就是"还没做的东西"的文档：里面提到不存在的脚本是正常的
PLAN_DOCS = ('docs/roadmap.md',)


def check_refs(mds):
    for m in mds:
        if is_readonly(m):
            continue
        for line_no, line in enumerate(read(m).splitlines(), 1):
            planned = m in PLAN_DOCS or any(w in line for w in _PLANNED)
            refs = re.findall(r'`(tools/[\w./-]+\.(?:py|mjs))`', line)
            refs += re.findall(r'`(单项工具/[^`]+\.bat)`', line)
            for ref in refs:
                if '<' in ref or '>' in ref:      # `单项工具/<动作>.bat` 这类占位符
                    continue
                if os.path.exists(os.path.join(ROOT, ref)):
                    continue
                if planned:
                    notes.append(f'[引用·计划或已删] {m}:{line_no} → {ref}（同行有计划/删除措辞，视为正常）')
                else:
                    errors.append(f'[引用] {m}:{line_no} 提到不存在的 {ref}，且同行没有"计划/已删"这类措辞')


# ── 4. 台账 / 地图覆盖率 ────────────────────────────────────────────────
def check_ledgers():
    led_path, mm_path = 'tools/README.md', 'site/assets/app/MODULE_MAP.md'
    if os.path.exists(os.path.join(ROOT, led_path)):
        led = read(led_path)
        for f in sorted(os.listdir(os.path.join(ROOT, 'tools'))):
            if f.endswith(('.py', '.mjs')) and f not in led:
                warns.append(f'[台账] tools/{f} 未登记在 {led_path}（跑 import_*/migrate_* 前要靠它判断死活）')
    if os.path.exists(os.path.join(ROOT, mm_path)):
        mm = read(mm_path)
        for f in sorted(os.listdir(os.path.join(ROOT, 'site/assets/app'))):
            if f.endswith('.js') and f not in mm:
                warns.append(f'[地图] site/assets/app/{f} 未收录在 MODULE_MAP.md')


# ── 5. 写死的数字 vs 数据真相 ───────────────────────────────────────────
def check_numbers(mds):
    cx_path = os.path.join(ROOT, 'site/data/codexes.json')
    if not os.path.exists(cx_path):
        notes.append('[数字] 本地无 site/data/codexes.json（可能是纯代码检出），跳过数字核对')
        return
    with open(cx_path, encoding='utf-8') as fh:
        cx = json.load(fh)
    books = cx if isinstance(cx, list) else cx.get('codexes', cx.get('items', []))
    n_books = len(books)
    n_entry = sum(b.get('entryCount') or 0 for b in books)
    n_img = sum(b.get('imagedCount') or 0 for b in books)
    notes.append(f'[真相] codexes.json：{n_books} 本 / {n_entry} 条 / 已配图 {n_img} '
                 f'（{n_img / n_entry * 100:.1f}%）')
    for m in mds:
        if is_readonly(m):
            continue
        body = read(m)
        # 刻意引用旧数字做例子的文档（如 docs/经验/文档规整.md）可挂免检标记
        if 'lint-docs: skip-numbers' in body:
            notes.append(f'[数字] {m} 挂了 skip-numbers 标记，跳过（刻意引用历史数字）')
            continue
        # 只有"看起来在描述全站规模"的句子才比对，否则分本计数会满屏误报
        scope = ('全站', '全部', '共', '总', '当前', '现有', '截至', '现状')
        for line_no, line in enumerate(body.splitlines(), 1):
            if not any(w in line for w in scope):
                continue
            for num in re.findall(r'(\d+) ?本(?:书)?[^\w]', line + ' '):
                if 5 <= int(num) <= 60 and int(num) != n_books:
                    warns.append(f'[数字] {m}:{line_no} 写着「{num} 本」，实际 {n_books} 本 —— '
                                 f'现状描述就改掉；历史叙述就补上日期，或干脆指向 codexes.json')
            for num in re.findall(r'(\d{2},?\d{3}) ?条', line):
                if int(num.replace(',', '')) not in (n_entry, n_img):   # 条数或已配图数都算对
                    warns.append(f'[数字] {m}:{line_no} 写着「{num} 条」，实际 {n_entry:,} 条')


# ── 6. 端口 vs launch.json ──────────────────────────────────────────────
def check_ports(mds):
    known = set()
    if os.path.exists(LAUNCH):
        with open(LAUNCH, encoding='utf-8') as fh:
            cfg = json.load(fh)
        for c in cfg.get('configurations', []):
            if c.get('port'):
                known.add(int(c['port']))
        notes.append(f'[真相] launch.json 端口：{sorted(known)}')
    else:
        notes.append('[端口] 找不到 launch.json，跳过端口核对')
        return
    # 工具自带端口（源码里 grep 得到的才算数）
    for f in sorted(os.listdir(os.path.join(ROOT, 'tools'))):
        if f.endswith('.py'):
            src = read(f'tools/{f}')
            for p in re.findall(r'(?:port|PORT)\s*=\s*(\d{4,5})', src):
                known.add(int(p))
    for m in mds:
        # 运维 runbook 讲的是生产/外部服务（自建中继等），端口本就不在本地清单里
        if is_readonly(m) or m.startswith('docs/运维/'):
            continue
        for line_no, line in enumerate(read(m).splitlines(), 1):
            for p in re.findall(r':(\d{4,5})[^\d]', line + ' '):
                if 1000 <= int(p) <= 65535 and int(p) not in known:
                    warns.append(f'[端口] {m}:{line_no} 提到 :{p}，'
                                 f'但 launch.json 与 tools/ 源码里都没有这个端口——是不是端口迁移后的残留？')


# ── 7. 字节预算 & 巨型文件 ──────────────────────────────────────────────
def check_budget(mds):
    total = 0
    for f, cap in BUDGET.items():
        p = os.path.join(ROOT, f)
        if not os.path.exists(p):
            continue
        size = fsize(f)
        if f in ('AGENTS.md', 'CLAUDE.md'):
            total += size
        flag = '' if size <= cap else f'  ⚠ 超出上限 {cap}B'
        (warns if size > cap else notes).append(f'[预算] {f} = {size}B（上限 {cap}B）{flag}')
    notes.append(f'[预算] always-loaded（AGENTS+CLAUDE）合计 {total}B ≈ {total // 3} tokens 量级，每次会话固定成本')
    for m in mds:
        size = fsize(m)
        if size > HUGE:
            t = read(m)
            has_anchor = bool(re.search(r'^## ', t, re.M))
            notes.append(f'[巨型] {m} = {size}B —— 只许 Grep 定位 + 分段 Read'
                         f'{"（有 `## ` 锚点 ✅）" if has_anchor else "（⚠ 没有稳定的 ## 锚点，Grep 定位困难）"}')


# ── 8. 孤儿：谁也不引用、任何索引都没收 ─────────────────────────────────
_MARKDOWN_LINK_RE = re.compile(r'\]\(\s*(?:<([^>]+)>|([^\s)]+))')


def markdown_link_targets(source: str, body: str) -> set[str]:
    """返回正文中指向仓库内 Markdown 文件的规范化相对路径。"""
    targets: set[str] = set()
    source_dir = os.path.dirname(source)
    for angle_target, plain_target in _MARKDOWN_LINK_RE.findall(body):
        raw = unquote(angle_target or plain_target).replace('\\', '/')
        parsed = urlsplit(raw)
        if parsed.scheme or parsed.netloc or not parsed.path.lower().endswith('.md'):
            continue
        path = parsed.path.lstrip('/') if parsed.path.startswith('/') else parsed.path
        target = os.path.normpath(os.path.join(source_dir, path)).replace('\\', '/')
        targets.add(target)
    return targets


def check_orphans(mds):
    referenced_by: dict[str, set[str]] = {}
    for source in mds:
        for target in markdown_link_targets(source, read(source)):
            referenced_by.setdefault(target, set()).add(source)
    roots = {'AGENTS.md', 'CLAUDE.md', 'HANDOFF.md', 'README.md', 'tools/README.md',
             'docs/architecture.md', 'docs/roadmap.md',
             'site/assets/app/MODULE_MAP.md'}
    for m in mds:
        if m in roots or m.endswith('/README.md'):
            continue
        if not any(source != m for source in referenced_by.get(m, ())):
            warns.append(f'[孤儿] {m} 没有被任何文档或索引引用——它实际上永远不会被读到')


# ── 9. HANDOFF 头行体检 ─────────────────────────────────────────────────
def check_handoff_header():
    p = 'HANDOFF.md'
    if not os.path.exists(os.path.join(ROOT, p)):
        return
    for line in read(p).splitlines():
        if re.match(r'^>?\s*(?:\*\*)?最后更新(?:\*\*)?[：:]', line.strip()):
            tail = line.split('最后更新', 1)[1]
            if len(tail) > 30:
                warns.append(f'[HANDOFF] 「最后更新」那行塞了状态摘要（{len(tail)} 字符）——'
                             f'只写日期，否则必然和正文打架')
            return
    warns.append('[HANDOFF] 找不到「最后更新」行')


# ── 10. 篇幅：索引条目 / HANDOFF 条目 / 新日志条目 ─────────────────────
def index_entries(text: str) -> list[str]:
    """索引里的条目行：表格数据行或 `- [` 列表行（模板注释不算）。"""
    text = re.sub(r'<!--.*?-->', '', text, flags=re.S)
    out = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith('- [') or (s.startswith('|') and not re.match(r'^\|[\s:|-]+\|$', s)
                                   and not s.startswith('| 篇 |') and not s.startswith('| 文件 |')):
            out.append(s)
    return out


def check_lengths():
    for d in INDEXED_DIRS:
        idx_path = f'{d}/README.md'
        if not os.path.exists(os.path.join(ROOT, idx_path)):
            continue
        rows = index_entries(read(idx_path))
        if not rows:
            continue
        avg = sum(map(nbytes, rows)) / len(rows)
        long_rows = [r for r in rows if nbytes(r) > INDEX_ENTRY_MAX]
        (warns if avg > INDEX_ENTRY_AVG else notes).append(
            f'[篇幅] {idx_path}：{len(rows)} 条，平均 {avg:.0f}B（建议 ≤ {INDEX_ENTRY_AVG}B）')
        for r in long_rows:
            warns.append(f'[篇幅] {idx_path} 有一条 {nbytes(r)}B：{r[:40]}…')
    if os.path.exists(os.path.join(ROOT, 'HANDOFF.md')):
        items = re.split(r'\n(?=- \*\*)', read('HANDOFF.md'))[1:]
        for it in items:
            body = re.split(r'\n## ', it)[0].strip()
            if nbytes(body) > HANDOFF_ITEM_MAX:
                warns.append(f'[篇幅] HANDOFF 一条 {nbytes(body)}B（建议 ≤ {HANDOFF_ITEM_MAX}B）：{body[:30]}…')
    log_dir = os.path.join(ROOT, 'docs', '日志')
    if os.path.isdir(log_dir):
        for f in sorted(os.listdir(log_dir)):
            if not re.match(r'\d{4}-\d{2}\.md$', f):
                continue
            for part in re.split(r'\n(?=## )', read(f'docs/日志/{f}')):
                m = re.match(r'## (\d{4}-\d{2}-\d{2})', part)
                if m and m.group(1) >= LOG_RULE_SINCE and nbytes(part.strip()) > LOG_ENTRY_MAX:
                    warns.append(f'[篇幅] docs/日志/{f} 条目「{part.splitlines()[0][3:40]}」'
                                 f'{nbytes(part.strip())}B（新条目建议 ≤ {LOG_ENTRY_MAX}B，细节放 output/ 报告）')


# ── 11. 内容放错地方的迹象 ──────────────────────────────────────────────
def docs_non_md() -> list[str]:
    out = []
    for base, dirs, files in os.walk(os.path.join(ROOT, 'docs')):
        r = rel(base)
        if r == 'docs/skills' or r.startswith('docs/skills/'):
            continue      # 技能源文件（含 agents/*.yaml），见 docs/经验/工程审查.md
        out += [rel(os.path.join(base, f)) for f in files if not f.endswith('.md')]
    return sorted(out)


# 刻意留在 docs/ 的非文档：搬走会断链或断图，登记原因后只记参考
KEEP_NON_MD = {
    'docs/动效方案演示.html': 'roadmap、经验篇和 site/assets/app/copy-fx.js 注释引用了它',
    'docs/Tag中转站原型.html': '用 ../site/images/ 相对路径引图，搬走图就断',
    'docs/Tag中转站原型-Codex版.html': '用 ../site/images/ 相对路径引图，搬走图就断',
}


def check_misplaced(mds):
    for f in docs_non_md():
        if f in KEEP_NON_MD:
            notes.append(f'[归位] {f} 刻意留在 docs/：{KEEP_NON_MD[f]}')
        else:
            warns.append(f'[归位] {f} 不是文档——原型、演示稿放 output/ 或归档（docs/skills/ 例外）')
    log_idx = 'docs/日志/README.md'
    if os.path.exists(os.path.join(ROOT, log_idx)):
        stray = [l for l in read(log_idx).splitlines()
                 if l.strip() and not l.lstrip().startswith(('#', '>', '|'))]
        if stray:
            warns.append(f'[归位] {log_idx} 有 {len(stray)} 行不是页头或月份表——'
                         f'「最新…」状态段落不写在这里，看当月日志开头')
    for m in mds:
        if not m.startswith(('docs/经验/', 'docs/运维/')) or m.endswith('/README.md'):
            continue
        in_code = False
        for line_no, line in enumerate(read(m).splitlines(), 1):
            if line.lstrip().startswith('```'):
                in_code = not in_code
                continue
            if not in_code and re.match(r'^#{2,4} (?:\d{4}-\d{2}-\d{2}|.*(?:落地结果|本轮|事故经过))', line):
                warns.append(f'[归位] {m}:{line_no} 标题像一次性过程记录：「{line[:40]}」——过程写进日志或报告')


# ── 12. 工作区：顶层目录登记、预览端口重复 ─────────────────────────────
def check_workspace():
    ws_agents = os.path.join(WORKSPACE, 'AGENTS.md')
    if os.path.exists(ws_agents):
        text = read_abs(ws_agents)
        # 只认「顶层目录一览」表格首列和「其它」小节里的条目，正文顺带提到的目录名不算登记
        registered = set(re.findall(r'(?m)^\|\s*`([^`/]+)/`', text))
        if '## 其它' in text:
            registered |= set(re.findall(r'`([^`/\s]+)/', text.split('## 其它', 1)[1]))
        for name in sorted(os.listdir(WORKSPACE)):
            if os.path.isdir(os.path.join(WORKSPACE, name)) and name not in registered:
                warns.append(f'[工作区] 顶层目录 {name}/ 没在工作区 AGENTS.md 登记')
    if os.path.exists(LAUNCH):
        with open(LAUNCH, encoding='utf-8') as fh:
            cfg = json.load(fh)
        by_port: dict[int, list[str]] = {}
        for c in cfg.get('configurations', []):
            if c.get('port'):
                by_port.setdefault(int(c['port']), []).append(c.get('name', '?'))
        for port, names in sorted(by_port.items()):
            if len(names) > 1:
                warns.append(f'[工作区] launch.json 端口 {port} 被 {" / ".join(names)} 同时占用，一起启动会冲突')


# ── 13. git 事实（供人对照文档里的状态断言）────────────────────────────
def git_facts():
    def sh(cmd):
        try:
            r = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True,
                               text=True, encoding='utf-8', errors='replace')
            return r.stdout.strip()
        except Exception as exc:                              # pragma: no cover
            return f'(取不到: {exc})'
    unpushed = sh('git log origin/main..HEAD --oneline')
    notes.append(f'[git] 未推送提交：{unpushed if unpushed else "无"}')
    dirty = sh('git status --short')
    notes.append(f'[git] 工作区改动：{dirty if dirty else "clean"}')
    nm = sh('git branch --no-merged main')
    notes.append(f'[git] 未并入 main 的分支：\n{nm if nm else "  无"}')
    wt = sh('git worktree list')
    notes.append(f'[git] worktree：\n{wt}')
    notes.append('      ↑ 拿这四项去对 HANDOFF 里「已推送 / 停靠中的分支 / 某目录存在」之类的断言')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--print', dest='echo', action='store_true',
                    help='顺便打到 stdout（控制台 GBK 可能乱码）')
    args = ap.parse_args()

    mds = all_md()
    check_indexes()
    check_deadlinks(mds)
    check_refs(mds)
    check_ledgers()
    check_numbers(mds)
    check_ports(mds)
    check_budget(mds)
    check_orphans(mds)
    check_handoff_header()
    check_lengths()
    check_misplaced(mds)
    check_workspace()
    git_facts()

    lines = [f'文档体检报告  ——  共扫描 {len(mds)} 篇 md',
             f'仓库：{ROOT}', '=' * 78, '']
    for title, bucket in (('ERROR（结构坏了，应当修）', errors),
                          ('WARN（需要人判断）', warns),
                          ('事实快照 / 参考', notes)):
        lines.append(f'## {title}  [{len(bucket)}]')
        lines.extend(f'  - {x}' for x in bucket) if bucket else lines.append('  （无）')
        lines.append('')
    lines += ['提示：只读区 docs/日志/ 与 docs/decisions/ 不参与现状类检查——',
              '      它们的旧数字旧端口是史实，改了即篡改历史。完整流程见 docs/经验/文档规整.md。']
    text = '\n'.join(lines)

    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, 'w', encoding='utf-8', newline='') as fh:
        fh.write(text)
    if args.echo:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        print(text)

    print(f'docs lint: {len(mds)} files, {len(errors)} errors, {len(warns)} warnings')
    print(f'report -> {os.path.relpath(REPORT, ROOT)}')
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
