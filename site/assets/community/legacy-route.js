/* 旧共创广场只保留书签/分享兼容；图片序号沿用原来的一基 image 参数。 */
export function communityLegacyTarget(href) {
  const previous = new URL(href);
  const target = new URL(previous.pathname.replace(/\/strings(?:\.html)?\/?$/, '/'), previous);
  target.searchParams.set('c', 'community');
  const entry = String(previous.searchParams.get('entry') || '').trim();
  if (entry) {
    target.searchParams.set('entry', entry);
    const rawImage = Number(previous.searchParams.get('image'));
    const image = Number.isFinite(rawImage) ? Math.max(1, Math.trunc(rawImage)) : 1;
    if (image > 1) target.searchParams.set('image', String(image));
  }
  return `${target.pathname}${target.search}`;
}

if (typeof location !== 'undefined' && /\/strings(?:\.html)?\/?$/.test(location.pathname)) {
  const target = communityLegacyTarget(location.href);
  const link = document.getElementById('communityRedirectLink');
  if (link) link.href = target;
  location.replace(target);
}
