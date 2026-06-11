'use strict';

import { json, emptyCollection, normalizeImageFile } from '../_lib.js';

function normalizeCommunityImageUrls(data) {
  if (!data || !Array.isArray(data.entries)) return data;
  let changed = false;
  const entries = data.entries.map(entry => {
    if (!entry || !Array.isArray(entry.images)) return entry;
    let entryChanged = false;
    const images = entry.images.map(image => {
      if (typeof image === 'string') {
        const file = normalizeImageFile(image);
        if (file !== image) {
          changed = true;
          entryChanged = true;
        }
        return file;
      }
      if (!image || typeof image !== 'object') return image;
      const file = normalizeImageFile(image.file);
      if (file === image.file) return image;
      changed = true;
      entryChanged = true;
      return { ...image, file };
    });
    return entryChanged ? { ...entry, images } : entry;
  });
  return changed ? { ...data, entries } : data;
}

// GET /api/community — 已发布的社区画风串列表（strings.js 的 dataUrl 指向这里）
export async function onRequestGet({ env }) {
  if (!env.STRINGS_BUCKET) return json(emptyCollection());
  const obj = await env.STRINGS_BUCKET.get('community/community.json');
  if (!obj) return json(emptyCollection());
  const data = await obj.json().catch(() => null);
  return json(normalizeCommunityImageUrls(data) || emptyCollection());
}
