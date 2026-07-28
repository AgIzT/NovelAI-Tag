import { state } from './state.js';
import { esc } from './utils.js';
import { entryImages, hasEntryImage } from './media.js';
import { isFav } from './favorites.js';

const searchableTextCache = new WeakMap();

export function searchableText(e) {
  const cached = searchableTextCache.get(e);
  if (cached !== undefined) return cached;
  const characterText = (e.characterPrompts || [])
    .flatMap(item => [item.label, item.prompt, item.negative]);
  const text = [e.title, e.tags, e.negative, ...characterText, e.note, e.rawTags, ...(e.path || [])]
    .join('\n')
    .toLowerCase();
  searchableTextCache.set(e, text);
  return text;
}

export function invalidateSearchableText(e) {
  return e && (typeof e === 'object' || typeof e === 'function')
    ? searchableTextCache.delete(e)
    : false;
}

export function parseSearchQuery(raw) {
  const input = String(raw || '').trim();
  if (!input) return { raw: '', isSyntax: false, text: '', highlightTerms: [] };
  const tokens = tokenizeQuery(input);
  const plan = {
    raw: input,
    isSyntax: false,
    text: '',
    path: null,
    hasImage: null,
    fav: null,
    author: '',
    codex: '',
    type: '',
    terms: [],
    highlightTerms: [],
  };
  const terms = [];
  let invalidSyntax = false;

  const termTokens = [];
  for (const tokenInfo of tokens) {
    const token = tokenInfo.value;
    const match = token.match(/^(path|has|fav|author|codex|book|source|type):(.+)$/i);
    if (!match) {
      terms.push(token);
      termTokens.push(tokenInfo);
      continue;
    }
    plan.isSyntax = true;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (!value) {
      invalidSyntax = true;
      break;
    }
    if (key === 'path') {
      const path = value.split('/').map(seg => seg.trim()).filter(Boolean);
      if (!path.length) invalidSyntax = true;
      else plan.path = path;
    } else if (key === 'has') {
      const v = value.toLowerCase();
      if (['image', 'img', 'true', 'yes', '有图'].includes(v)) plan.hasImage = true;
      else if (['noimage', 'none', 'false', 'no', '无图'].includes(v)) plan.hasImage = false;
      else invalidSyntax = true;
    } else if (key === 'fav') {
      const v = value.toLowerCase();
      if (['true', '1', 'yes', '收藏'].includes(v)) plan.fav = true;
      else if (['false', '0', 'no', '未收藏'].includes(v)) plan.fav = false;
      else invalidSyntax = true;
    } else if (key === 'author') {
      plan.author = value.toLowerCase();
    } else if (key === 'codex' || key === 'book' || key === 'source') {
      plan.codex = value.toLowerCase();
    } else if (key === 'type') {
      plan.type = value.toLowerCase();
    }
    if (invalidSyntax) break;
  }

  if (invalidSyntax) {
    const fallbackTerms = searchTermsFromTokens(tokens);
    return {
      raw: input,
      isSyntax: false,
      text: tokens.map(token => token.value).join(' ').toLowerCase(),
      terms: fallbackTerms,
      highlightTerms: fallbackTerms,
    };
  }

  plan.text = terms.join(' ').trim().toLowerCase();
  plan.terms = searchTermsFromTokens(termTokens);
  plan.highlightTerms = plan.terms;
  return plan;
}

export function splitQueryTokens(input) {
  return tokenizeQuery(input).map(token => token.value);
}

function tokenizeQuery(input) {
  const tokens = [];
  let buf = '';
  let quote = '';
  let quoted = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = '';
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) {
        tokens.push({ value: buf, quoted });
        buf = '';
        quoted = false;
      }
      continue;
    }
    buf += ch;
  }
  if (buf) tokens.push({ value: buf, quoted });
  return tokens;
}

function searchTermsFromTokens(tokens) {
  const terms = tokens.flatMap(token => (
    token.quoted
      ? [String(token.value || '').trim().toLowerCase()]
      : highlightTermsFromText(token.value)
  )).filter(Boolean);
  return [...new Set(terms)]
    .sort((a, b) => b.length - a.length)
    .slice(0, 10);
}

export function matchSearchPlan(e, plan) {
  const terms = plan.terms?.length ? plan.terms : (plan.text ? [plan.text] : []);
  if (terms.length) {
    const text = searchableText(e);
    if (!terms.every(term => text.includes(term))) return false;
  }
  if (!plan.isSyntax) return true;
  if (plan.path && !pathMatchesQuery(e.path || [], plan.path)) return false;
  if (plan.hasImage !== null && hasEntryImage(e) !== plan.hasImage) return false;
  if (plan.fav !== null && isFav(e) !== plan.fav) return false;
  if (plan.author && !entryAuthorText(e).includes(plan.author)) return false;
  if (plan.codex && !entryCodexText(e).includes(plan.codex)) return false;
  if (plan.type && !entryTypeText(e).includes(plan.type)) return false;
  return true;
}

export function pathMatchesQuery(path, queryPath) {
  if (!queryPath.length) return true;
  const joined = path.join('/').toLowerCase();
  const qJoined = queryPath.join('/').toLowerCase();
  if (joined.includes(qJoined)) return true;
  return queryPath.every(seg => path.some(p => String(p).toLowerCase().includes(seg.toLowerCase())));
}

export function entryAuthorText(e) {
  const imageAuthors = entryImages(e).flatMap(img => [img.author, img.credit]);
  const contributors = Array.isArray(e._srcContributors)
    ? e._srcContributors.map(p => typeof p === 'string' ? p : `${p.name || ''} ${p.role || ''}`)
    : (Array.isArray(state.codex?.contributors) ? state.codex.contributors.map(p => typeof p === 'string' ? p : `${p.name || ''} ${p.role || ''}`) : []);
  return [e._srcAuthor, e._srcSource, state.codex?.author, state.codex?.source, e.author, e.credit, ...imageAuthors, ...contributors]
    .join('\n')
    .toLowerCase();
}

export function entryCodexText(e) {
  return [e._srcCodexId, e._srcCodexTitle, state.codex?.id, state.codex?.title]
    .join('\n')
    .toLowerCase();
}

export function entryTypeText(e) {
  const type = e._srcType || state.codex?.type || '';
  const labels = {
    codex: 'codex 法典',
    string: 'string 画风串',
    pack: 'pack 图包 精选图包',
  };
  return [type, labels[type] || ''].join('\n').toLowerCase();
}

export function highlightTermsFromText(text) {
  const terms = String(text || '')
    .split(/[\s,，、]+/)
    .map(s => s.trim())
    .filter(Boolean);
  return [...new Set(terms.map(s => s.toLowerCase()))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 10);
}

export function currentHighlightTerms() {
  return state.searchPlan?.highlightTerms || [];
}

export function renderHighlightedText(el, text, terms = []) {
  if (!el) return;
  const raw = String(text || '');
  const needles = terms.filter(Boolean);
  if (!needles.length) {
    el.textContent = raw;
    return;
  }
  const lower = raw.toLowerCase();
  const frag = document.createDocumentFragment();
  let pos = 0;
  while (pos < raw.length) {
    let bestIndex = -1;
    let bestTerm = '';
    for (const term of needles) {
      const index = lower.indexOf(term, pos);
      if (index === -1) continue;
      if (bestIndex === -1 || index < bestIndex || (index === bestIndex && term.length > bestTerm.length)) {
        bestIndex = index;
        bestTerm = term;
      }
    }
    if (bestIndex === -1) {
      frag.appendChild(document.createTextNode(raw.slice(pos)));
      break;
    }
    if (bestIndex > pos) frag.appendChild(document.createTextNode(raw.slice(pos, bestIndex)));
    const mark = document.createElement('mark');
    mark.textContent = raw.slice(bestIndex, bestIndex + bestTerm.length);
    frag.appendChild(mark);
    pos = bestIndex + bestTerm.length;
  }
  el.replaceChildren(frag);
}
