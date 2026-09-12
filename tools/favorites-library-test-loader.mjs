import { readFile } from 'node:fs/promises';

// 浏览器模块以 data URL 加载；保留真实 core/store，只替换 DOM toast。
export async function loadFavoritesTestModules() {
  const urls = new Map();
  const makeUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  urls.set('./feedback.js', makeUrl('export function toast() {}'));
  for (const name of ['favorites-backup-core', 'favorites-library-core', 'favorites-library-store', 'favorites-backup-store', 'favorites-origin-migration']) {
    let source = await readFile(new URL('../site/assets/app/' + name + '.js', import.meta.url), 'utf8');
    for (const [path, url] of urls) source = source.replaceAll("from '" + path + "'", "from '" + url + "'");
    urls.set('./' + name + '.js', makeUrl(source));
  }
  const names = { core: 'favorites-backup-core', library: 'favorites-library-core', store: 'favorites-library-store', backupStore: 'favorites-backup-store', migration: 'favorites-origin-migration' };
  const modules = {};
  for (const [key, name] of Object.entries(names)) modules[key] = await import(urls.get('./' + name + '.js'));
  return modules;
}
