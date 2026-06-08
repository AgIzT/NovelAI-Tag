# -*- coding: utf-8 -*-
"""
法典转换器：把 法典源/*.docx 解析成网站用的结构化数据。
输出：
  site/data/<codexId>.json   每本法典的词条 + 目录树
  site/data/codexes.json     法典索引（给顶部切换用）
  site/data/待复核_<codexId>.txt  可能解析有误的词条，供人工复核
用法：python tools/convert.py   （或双击 转换法典.bat）
"""
import os, re, io, json, hashlib, glob
from collections import defaultdict
from docx import Document
from docx.oxml.ns import qn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "法典源")
DATA_DIR = os.path.join(ROOT, "site", "data")
IMG_DIR = os.path.join(ROOT, "site", "images")
ORIG_DIR = os.path.join(ROOT, "originals")
os.makedirs(DATA_DIR, exist_ok=True)

# 已知法典 → 短 id（其余用文件名哈希）
ID_MAP = [("所长常规", "suozhang")]   # 原「所长常规」法典固定用 suozhang（已配图，勿改）；其余按文件名生成唯一 id
META_OVERRIDES = {
    "suozhang": {"author": "戒红所"},
    "codex_6e699406": {"title": "所长色色NovalAI个人法典(上)", "author": "戒红所"},
    "codex_8489ac52": {"title": "所长色色NovalAI个人法典(下)", "author": "戒红所"},
}
IMG_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "avif"]

def codex_id(stem):
    for key, cid in ID_MAP:
        if key in stem:
            return cid
    return "codex_" + hashlib.md5(stem.encode("utf-8")).hexdigest()[:8]

def parse_meta(stem):
    ver = re.search(r"(\d{4}[.\-]\d{1,2}[.\-]?\d{0,2})", stem)
    title = re.sub(r"[（(]\d{4}[.\-]\d{1,2}.*$", "", stem).strip()
    if title == stem:
        title = re.split(r"[（(]", stem)[0].strip()
    author = ""
    m = re.search(r"[（(].*?([一-鿿]{2,})整理", stem)
    if m:
        author = m.group(1)
    return title or stem, (ver.group(1) if ver else ""), author

def is_cjk(c):
    return "一" <= c <= "鿿"

def has_cjk(t):
    return any(is_cjk(c) for c in t)

def cjk_ratio(t):
    cjk = sum(1 for c in t if is_cjk(c))
    al = sum(1 for c in t if c.isalnum() or is_cjk(c))
    return cjk / al if al else 0.0

def classify(t):
    """把一段文本判定为 词条标题(title) / tag行(tag) / 其它(note)"""
    r = cjk_ratio(t)
    if r > 0.5 and len(t) < 45:          # 中文为主的短行 → 标题（即便夹少量英文/括号）
        return "title"
    if re.match(r"^(角色|人物)\d*[：:]", t):
        return "tag"
    if re.match(r"^[一-鿿]", t):
        return "title"                   # 中文开头的标题常会夹英文 tag 注释
    has_latin = bool(re.search(r"[A-Za-z]", t))
    has_tagsig = any(s in t for s in [",", "，", "::", "{", "}", "[", "]", "_"])
    if has_latin and has_tagsig:          # 含英文且有tag语法 → tag行
        return "tag"
    if len(t) < 45 and has_cjk(t):        # 中英混排的短标题（如 上古galgame风格）
        return "title"
    if len(t) < 35 and has_latin:         # 极短的纯英文标签 → 当标题
        return "title"
    return "note"

def visible_lines(t):
    """Word 段落里可能用软换行塞了多条内容；按肉眼看到的行拆开解析。"""
    return [x.strip() for x in t.splitlines() if x.strip()]

def is_dictionary_path(path):
    return len(path) >= 2 and path[0] == "各式场景" and path[1] == "视角与打光"

def should_skip_path(path):
    return path[:1] == ["自然语言"]

def dictionary_term(t):
    if "：" in t:
        left, right = t.split("：", 1)
    elif ":" in t:
        left, right = t.split(":", 1)
    else:
        return None
    term = left.strip()
    desc = right.strip()
    if not term or not desc:
        return None
    if not re.search(r"[A-Za-z]", term):
        return None
    if not has_cjk(desc):
        return None
    if len(term) > 80:
        return None
    return term

def strip_number_prefix(t):
    m = re.match(r"^\s*(\d+)[，,、.．]\s*(.+)$", t)
    if m:
        return m.group(1), m.group(2).strip()
    return None, t.strip()

def is_artist_group_entry(e):
    return e["path"][-1:] == ["编纂者常用画师组"] and e["title"].startswith("NAI")

def expand_special_entries(entries):
    """把已知的复合词条拆成更适合网页复制的独立卡片。"""
    out = []
    for e in entries:
        if not is_artist_group_entry(e):
            out.append(e)
            continue

        tag_lines = []
        for block in e["tags"]:
            tag_lines.extend(visible_lines(block))

        base = e["title"].rstrip("：:")
        for i, line in enumerate(tag_lines, 1):
            num, tags = strip_number_prefix(line)
            label = num or str(i)
            title = e["title"] if i == 1 else f"{base}：{label}"
            out.append({
                "title": title,
                "path": e["path"],
                "tags": [tags],
                "isNew": e["isNew"],
            })
    return out

def load_existing_entries(cid):
    jp = os.path.join(DATA_DIR, cid + ".json")
    if not os.path.exists(jp):
        return []
    try:
        with open(jp, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("entries", [])
    except Exception:
        return []

def norm_tags(t):
    return re.sub(r"\s+", " ", (t or "").replace("\u00a0", " ")).strip()

def tag_match_score(new_tags, old_tags):
    new = norm_tags(new_tags)
    old = norm_tags(old_tags)
    if not new or not old:
        return 0
    if new == old:
        return 1000000
    if old.startswith(new):
        return 800000 + len(new)
    if new.startswith(old):
        return 700000 + len(old)

    n = 0
    for a, b in zip(new, old):
        if a != b:
            break
        n += 1
    return n

def assign_stable_ids(cid, items):
    """复用旧 JSON 中的 id，避免修解析规则后把已配图词条整体错位。"""
    old_entries = load_existing_entries(cid)
    if not old_entries:
        final = []
        for i, item in enumerate(items, 1):
            eid = f"{cid}-{i:04d}"
            final.append({**item, "id": eid, **image_metadata(cid, eid)})
        return final

    old_by_key = defaultdict(list)
    old_ids = set()
    max_n = 0
    id_re = re.compile(r"^" + re.escape(cid) + r"-(\d+)$")
    for old in old_entries:
        oid = old.get("id")
        if oid:
            old_ids.add(oid)
            m = id_re.match(oid)
            if m:
                max_n = max(max_n, int(m.group(1)))
        key = (tuple(old.get("path", [])), old.get("title", ""))
        old_by_key[key].append(old)

    used = set()
    next_n = max_n + 1

    def fresh_id():
        nonlocal next_n
        while True:
            eid = f"{cid}-{next_n:04d}"
            next_n += 1
            if eid not in used and eid not in old_ids:
                return eid

    final = []
    for item in items:
        key = (tuple(item["path"]), item["title"])
        best = None
        best_score = -1
        for old in old_by_key.get(key, []):
            oid = old.get("id")
            if not oid or oid in used:
                continue
            score = tag_match_score(item["tags"], old.get("tags", ""))
            if score > best_score:
                best = old
                best_score = score

        eid = best.get("id") if best is not None else fresh_id()
        used.add(eid)
        final.append({**item, "id": eid, **image_metadata(cid, eid, best)})
    return final

def outline_lvl(p):
    pPr = p._p.pPr
    if pPr is None:
        return None
    o = pPr.find(qn("w:outlineLvl"))
    return int(o.get(qn("w:val"))) if o is not None else None

def is_pink(p):
    for r in p.runs:
        rPr = r._element.rPr
        if rPr is not None:
            hh = rPr.find(qn("w:highlight"))
            if hh is not None and hh.get(qn("w:val")) not in (None, "none"):
                return True
    return False

def find_image(cid, eid):
    for ext in IMG_EXTS:
        fn = os.path.join(IMG_DIR, cid, eid + "." + ext)
        if os.path.exists(fn):
            return eid + "." + ext
    return None

def find_original(cid, eid):
    for ext in IMG_EXTS:
        fn = os.path.join(ORIG_DIR, cid, eid + "." + ext)
        if os.path.exists(fn):
            return eid + "." + ext
    return None

def local_asset_rev(cid, image, original):
    h = hashlib.sha256()
    found = False
    for root, fn in ((IMG_DIR, image), (ORIG_DIR, original)):
        if not fn:
            continue
        path = os.path.join(root, cid, fn)
        if not os.path.exists(path):
            continue
        st = os.stat(path)
        h.update(f"{fn}:{st.st_size}:{st.st_mtime_ns}".encode("utf-8"))
        found = True
    return h.hexdigest()[:16] if found else None

def image_metadata(cid, eid, old=None):
    old = old or {}
    image = old.get("image") or find_image(cid, eid)
    original = old.get("original") or find_original(cid, eid)
    asset_rev = old.get("assetRev") or local_asset_rev(cid, image, original)
    meta = {"image": image}
    if original:
        meta["original"] = original
    if asset_rev:
        meta["assetRev"] = asset_rev
    return meta

def build_tree(entries):
    root = {}
    for e in entries:
        node = root
        for name in e["path"]:
            node = node.setdefault(name, {"_count": 0, "_children": {}})
            node["_count"] += 1
            node = node["_children"]
    def to_list(d):
        out = []
        for name, v in d.items():
            out.append({"name": name, "count": v["_count"], "children": to_list(v["_children"])})
        return out
    return to_list(root)

def convert(path, cid):
    stem = os.path.splitext(os.path.basename(path))[0]
    title, ver, author = parse_meta(stem)
    meta = META_OVERRIDES.get(cid, {})
    title = meta.get("title", title)
    author = meta.get("author", author)
    doc = Document(path)

    cats = [None, None, None, None]
    entries, cur = [], None
    seen_toc = False
    for p in doc.paragraphs:
        if p.style.name.startswith("toc"):
            seen_toc = True
            continue
        lines = visible_lines(p.text)
        if not lines:
            continue
        lv = outline_lvl(p)
        if lv is not None and lv <= 3:
            cats[lv] = " ".join(lines)
            for k in range(lv + 1, 4):
                cats[k] = None
            cur = None
            continue
        if not seen_toc:            # 跳过目录之前的零碎
            continue
        path_now = [c for c in cats if c]
        if should_skip_path(path_now):
            cur = None
            continue
        for t in lines:
            term = dictionary_term(t) if is_dictionary_path(path_now) else None
            if term is not None:
                cur = {"title": t, "path": path_now, "tags": [term], "isNew": is_pink(p)}
                entries.append(cur)
                cur = None
                continue

            kind = classify(t)
            if kind == "title":
                cur = {"title": t, "path": path_now, "tags": [], "isNew": is_pink(p)}
                entries.append(cur)
            elif kind == "tag":
                if cur is None:
                    cur = {"title": "(未命名)", "path": path_now, "tags": [], "isNew": False}
                    entries.append(cur)
                cur["tags"].append(t)
                if is_pink(p):
                    cur["isNew"] = True
            # note: 丢弃

    # 仅保留有 tag 的词条；合并 tag 行；复用旧 id；探测配图
    items, review = [], []
    for e in expand_special_entries(entries):
        if not e["tags"]:
            continue
        block = "\n".join(e["tags"]).strip()
        items.append({
            "title": e["title"],
            "path": e["path"],
            "tags": block,
            "isNew": e["isNew"],
        })

    final = assign_stable_ids(cid, items)
    for item in final:
        block = item["tags"]
        is_dict = is_dictionary_path(item["path"])
        # 可疑：tag 块里没有任何逗号/:: → 可能是误判
        if (not is_dict) and ("," not in block) and ("，" not in block) and ("::" not in block):
            review.append(item)
        elif (not is_dict) and len(item["title"]) > 30:
            review.append(item)

    tree = build_tree(final)
    imaged = sum(1 for e in final if e["image"])

    with io.open(os.path.join(DATA_DIR, cid + ".json"), "w", encoding="utf-8") as f:
        json.dump({
            "id": cid, "title": title, "version": ver, "author": author,
            "entryCount": len(final), "imagedCount": imaged,
            "tree": tree, "entries": final,
        }, f, ensure_ascii=False)

    if review:
        with io.open(os.path.join(DATA_DIR, f"待复核_{cid}.txt"), "w", encoding="utf-8") as f:
            f.write(f"# {title}：{len(review)} 条可能解析有误，请人工瞄一眼\n\n")
            for e in review:
                f.write(f"[{' › '.join(e['path'])}] {e['title']}\n    {e['tags'][:120]}\n\n")

    return {"id": cid, "title": title, "version": ver, "author": author,
            "entryCount": len(final), "imagedCount": imaged, "reviewCount": len(review)}

def main():
    docs = sorted(glob.glob(os.path.join(SRC_DIR, "*.docx")))
    META_KEYS = ("id", "title", "version", "author", "entryCount", "imagedCount")
    index = []
    seen = {}
    produced = set()
    for d in docs:
        if os.path.basename(d).startswith("~$"):
            continue
        stem = os.path.splitext(os.path.basename(d))[0]
        cid = codex_id(stem)
        if cid in seen:                       # 防撞：同 id 自动加后缀，杜绝互相覆盖
            seen[cid] += 1
            cid = f"{cid}_{seen[cid]}"
        else:
            seen[cid] = 1
        info = convert(d, cid)
        produced.add(info["id"])
        index.append({k: info[k] for k in META_KEYS})
        print(f"[OK] {info['id']}: {info['entryCount']} entries, "
              f"{info['imagedCount']} imaged, {info['reviewCount']} to review")

    # 冻结保留：有数据文件、但本次没有对应 docx 的法典，原样保留在索引里
    # （不重新生成 → 护住你手动改过的 JSON；想彻底删除某本就删它的 <id>.json）
    for jf in sorted(glob.glob(os.path.join(DATA_DIR, "*.json"))):
        cid = os.path.splitext(os.path.basename(jf))[0]
        if cid == "codexes" or cid in produced:
            continue
        try:
            with open(jf, encoding="utf-8") as f:
                kept = json.load(f)
            if "entries" not in kept:         # 不是法典数据文件，跳过
                continue
            index.append({k: kept.get(k) for k in META_KEYS})
            print(f"[KEEP] {cid}: kept from existing data (no docx) - {kept.get('entryCount')} entries")
        except Exception as ex:
            print(f"[SKIP] {os.path.basename(jf)}: {ex}")

    with io.open(os.path.join(DATA_DIR, "codexes.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"[DONE] {len(index)} codex(es) -> site/data/")

if __name__ == "__main__":
    main()
