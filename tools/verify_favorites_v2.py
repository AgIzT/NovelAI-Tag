"""收藏夹 V2 的真实浏览器回归；仅在独立浏览器配置与回环预览上运行。"""
from __future__ import annotations

import argparse
import json
import os
import traceback
from pathlib import Path
from urllib.parse import urlsplit

import verify_ui as ui

ROOT = Path(__file__).resolve().parents[1]


def run(base, out, cdp):
    results = []
    ui.disable_motion(cdp)
    ui.install_error_capture(cdp)
    ui.navigate(cdp, base + '?c=suozhang')
    ui.wait_for(cdp, "document.querySelectorAll('.card').length > 0", 'source cards')

    def modules(page=cdp):
        page.eval("""(async()=>{window.qa={}; for(const [name,file] of Object.entries({
          app:'../app.js',state:'state.js',core:'favorites-library-core.js',store:'favorites-library-store.js',
          view:'favorites-view.js',fav:'favorites.js',blocking:'content-blocking.js',history:'browser-history.js',
          codex:'fav-codex.js',masonry:'masonry.js',access:'access.js',copy:'copy.js',lightbox:'lightbox.js',data:'data.js'})) qa[name]=await import('/assets/app/'+file);
          qa.s=qa.state.state; return true;})()""")

    modules()
    keys = cdp.eval("qa.s.codex.entries.filter(e=>e.image||e.images?.length).slice(0,12).map(e=>'suozhang:'+e.id)")
    cdp.eval("localStorage.removeItem('fadian-favs-v2'); localStorage.setItem('fadian-favs',JSON.stringify(" + json.dumps(keys) + ")); true")
    ui.navigate(cdp, base + '?c=suozhang&fav=1&p=legacy')
    ui.wait_for(cdp, "document.querySelectorAll('.favorite-library-card').length >= 5", 'favorite cards', timeout=20)
    modules()

    def test(name, script):
        def check():
            value = cdp.eval('(async()=>{const assert=(v,m)=>{if(!v)throw new Error(m)};' + script + '})()', timeout=25)
            ui.check_no_errors(cdp)
            return value
        ui.run_check(results, name, check)
        if not results[-1]['ok']:
            ui.screenshot(cdp, out, 'failure')
            raise ui.CheckFailed(name)

    test('migration and folder shell', """
      const d=qa.store.librarySnapshot();
      assert(d.items.length===12 && d.items.every(i=>i.addedAt===null),'migration exact');
      assert(d.memberships.length===0 && d.folders.length===0,'migration unclassified');
      assert(!new URL(location.href).searchParams.has('p'),'old directory route removed');
      assert(getComputedStyle(document.querySelector('#tree')).display==='none','old tree hidden');
      assert(document.querySelector('#favoritesHeader h1').textContent==='全部','folder header');
      return {items:d.items.length,rows:document.querySelectorAll('.favorites-folder-row').length};
    """)
    test('create and join atomically through organize panel', """
      qa.first=qa.fav.favKey(qa.s.list[0]);
      document.querySelector('.favorite-organize-button').click();
      await new Promise(r=>setTimeout(r,200));
      assert(!document.querySelector('#favoritesOrganize').hidden,'organize opens');
      const input=document.querySelector('#favoritesOrganizeName'); input.value='画风参考';
      document.querySelector('.favorites-organize-new').requestSubmit();
      await new Promise(r=>setTimeout(r,220));
      let d=qa.store.librarySnapshot(); qa.folderA=d.folders.find(f=>f.name==='画风参考').id;
      assert(d.memberships.some(m=>m.itemKey===qa.first&&m.folderId===qa.folderA),'atomic join');
      input.value='角色与服装'; document.querySelector('.favorites-organize-new').requestSubmit();
      await new Promise(r=>setTimeout(r,220));
      d=qa.store.librarySnapshot(); qa.folderB=d.folders.find(f=>f.name==='角色与服装').id;
      assert(d.items.length===12&&d.memberships.length===2,'multiple folders one item');
      assert(qa.view.countVisible(d.items.map(i=>i.key))===12,'all count');
      assert([...document.querySelectorAll('.favorites-organize-row')].every(r=>r.getAttribute('aria-checked')==='true'),'both selected');
      document.querySelector('#favoritesOrganize .favorites-dialog-footer button').click();
      await new Promise(r=>setTimeout(r,200));
      return {folders:d.folders.length,memberships:d.memberships.length};
    """)
    test('membership badge height and batch move undo', """
      await new Promise(r=>setTimeout(r,300));
      let card=[...document.querySelectorAll('.card')].find(c=>c.dataset.favoriteKey===qa.first);
      assert(card.querySelectorAll('.favorite-folder-badge').length===2,'two badges');
      const before=card.style.height;
      Object.defineProperty(window,'innerHeight',{value:innerHeight-50,configurable:true}); window.dispatchEvent(new Event('resize'));
      await new Promise(r=>setTimeout(r,650));
      assert(card.style.height===before,'height-only resize stable');
      delete window.innerHeight;
      document.querySelector('[data-folder-id="'+qa.folderA+'"] .favorites-folder-open').click();
      await new Promise(r=>setTimeout(r,220));
      assert(qa.s.list.length===1,'folder filter');
      [...document.querySelectorAll('.favorites-desktop-controls button')].find(b=>b.textContent==='选择').click();
      document.querySelector('.card').click();
      assert(qa.s.favSelected.size===1 && !qa.s.lightbox.entry,'selection capture');
      [...document.querySelectorAll('#favoritesBatchBar button')].find(b=>b.textContent==='移出本夹').click();
      await new Promise(r=>setTimeout(r,250));
      let d=qa.store.librarySnapshot();
      assert(d.items.length===12&&d.memberships.length===1&&d.memberships[0].folderId===qa.folderB,'move keeps item and other folder');
      document.querySelector('#toast .toast-action').click();
      await new Promise(r=>setTimeout(r,250));
      assert(qa.store.librarySnapshot().memberships.length===2,'move undo');
      [...document.querySelectorAll('#favoritesBatchBar button')].find(b=>b.textContent==='完成').click();
      await new Promise(r=>setTimeout(r,180)); return {height:before};
    """)
    test('delete folder undo keeps all favorites', """
      document.querySelector('[data-folder-id="'+qa.folderA+'"] .favorites-folder-more').click();
      [...document.querySelectorAll('#favoritesMenu button')].find(b=>b.textContent==='删除收藏夹').click();
      [...document.querySelectorAll('#favoritesDialog button')].find(b=>b.textContent==='删除收藏夹').click();
      await new Promise(r=>setTimeout(r,250));
      assert(qa.store.librarySnapshot().items.length===12,'delete kept favorites');
      assert(!qa.store.librarySnapshot().folders.some(f=>f.id===qa.folderA),'folder deleted');
      document.querySelector('#toast .toast-action').click(); await new Promise(r=>setTimeout(r,220));
      assert(qa.store.librarySnapshot().folders.some(f=>f.id===qa.folderA),'folder undo');
      return true;
    """)
    test('single favorite undo and quota failure are truthful', """
      let entry=qa.s.list[0]; const key=qa.fav.favKey(entry);
      await qa.fav.toggleFav(entry); const undo=document.querySelector('#toast .toast-action');
      assert(undo?.textContent==='撤销'&&!qa.s.favs.has(key),'remove committed');
      undo.click(); await new Promise(r=>setTimeout(r,250));
      assert(qa.s.favs.has(key)&&qa.s.list.some(e=>qa.fav.favKey(e)===key),'undo rebuild includes entry');
      const set=Storage.prototype.setItem; const bytes=localStorage.getItem('fadian-favs-v2');
      Storage.prototype.setItem=function(k,v){if(k==='fadian-favs-v2')throw new DOMException('full','QuotaExceededError'); return set.call(this,k,v)};
      let result; try{result=await qa.fav.toggleFav(entry);}finally{Storage.prototype.setItem=set;}
      assert(!result.ok&&result.reason==='quota'&&qa.s.favs.has(key),'quota keeps state');
      assert(localStorage.getItem('fadian-favs-v2')===bytes,'quota keeps disk');
      assert(document.querySelector('#toast').textContent.includes('浏览器存储已满'),'quota truthful toast');
      return {reason:result.reason};
    """)
    test('personal blocking and all count agree', """
      const e=qa.s.list[0],key=qa.fav.favKey(e);
      qa.blocking.hideContentEntry(e); qa.app.applyFilter({transition:'none'});
      assert(!qa.s.list.some(i=>qa.fav.favKey(i)===key),'blocked absent');
      assert(qa.view.countVisible(qa.store.librarySnapshot().items.map(i=>i.key))===11,'blocked count');
      assert(document.querySelector('[data-folder-id=""] .favorites-count').textContent==='11','rail count');
      qa.blocking.restoreContentEntry(key);qa.app.applyFilter({transition:'none'});return true;
    """)
    ui.screenshot(cdp, out, 'desktop-folders')

    # 第二页使用同一隔离 profile，真实 storage 事件和 Web Locks，无手动派发替身事件。
    target = cdp.command('Target.createTarget', {'url': base + '?c=suozhang&fav=1'})['targetId']
    port_pages = ui.http_json(run.debug_base + '/json/list')
    peer = ui.CDP(next(p['webSocketDebuggerUrl'] for p in port_pages if p['id'] == target))
    try:
        ui.wait_for(peer, "document.querySelectorAll('.favorite-library-card').length>0", 'peer cards', timeout=20)
        modules(peer)
        peer.command('Runtime.evaluate', {'expression': "window.peerTx=qa.store.commitLibrary(d=>qa.core.createFolder(d,'并发乙'))"})
        local_tx = cdp.eval("qa.store.commitLibrary(d=>qa.core.createFolder(d,'并发甲'))")
        peer_tx = peer.eval('window.peerTx')
        print('Cross-tab transactions: '+json.dumps({'local':local_tx,'peer':peer_tx}, ensure_ascii=False), flush=True)
        if not local_tx.get('ok') or not peer_tx.get('ok'):
            raise ui.CheckFailed('Cross-tab write failed')
        ui.wait_for(cdp, "qa.store.librarySnapshot().folders.some(f=>f.name==='并发乙')", 'peer write visible')
        ui.wait_for(peer, "qa.store.librarySnapshot().folders.some(f=>f.name==='并发甲')", 'local write visible')
        test('two tabs retain both writes and refresh UI', """
          assert(document.querySelector('#favoritesRail').textContent.includes('并发乙'),'remote rail refreshed');
          return {names:qa.store.librarySnapshot().folders.map(f=>f.name)};
        """)
    finally:
        peer.close()
        cdp.command('Target.closeTarget', {'targetId': target})

    books = ['nai45_community_pack','nai5_community_pack','artist_nai45_personal','suozhang','artist_nai5_personal','kisegaeningyou','jiegou_yuandian']
    fixture = []
    for i, name in enumerate(books):
        data = json.loads((ROOT/'site'/'data'/f'{name}.json').read_text(encoding='utf-8'))
        fixture.extend(name+':'+e['id'] for e in data['entries'][:58 if i == 0 else 57])
    cdp.eval("localStorage.removeItem('fadian-favs-v2');localStorage.setItem('fadian-favs',JSON.stringify("+json.dumps(fixture)+"));localStorage.setItem('fadian-nsfw-ok','1');true")
    ui.navigate(cdp, base+'?c=suozhang&fav=1')
    ui.wait_for(cdp, "document.querySelectorAll('.favorite-library-card').length>0", '400 favorite wall', timeout=30)
    modules()
    test('400 favorite performance baseline and stable migrated order', r"""
      assert(qa.s.favs.size===400,'400 fixture');
      const order=qa.s.list.map(qa.fav.favKey); assert(JSON.stringify(order)===JSON.stringify([...order].sort()),'stable migrated key order');
      const timings=[];for(let i=0;i<9;i++){let t=performance.now();await qa.codex.buildFavoritesCodex();timings.push(performance.now()-t);}
      timings.sort((a,b)=>a-b);
      const resources=performance.getEntriesByType('resource').filter(r=>/data\/(nai45_community_pack|nai5_community_pack|artist_nai45_personal|suozhang|artist_nai5_personal|kisegaeningyou|jiegou_yuandian)\.json/.test(r.name));
      const result={items:qa.s.favs.size,visible:qa.s.list.length,warmMedianMs:timings[4],decodedBytes:resources.reduce((n,r)=>n+r.decodedBodySize,0),resources:resources.map(r=>({name:r.name.split('/').pop(),bytes:r.decodedBodySize}))};
      sessionStorage.setItem('qa-favorite-order',JSON.stringify(order));return result;
    """)
    for index in range(2):
        ui.navigate(cdp, base+'?c=suozhang&fav=1')
        ui.wait_for(cdp, "document.querySelectorAll('.favorite-library-card').length>0", 'stable refresh', timeout=30)
        modules()
        test('migrated order survives refresh '+str(index+1), "assert(JSON.stringify(qa.s.list.map(qa.fav.favKey))===sessionStorage.getItem('qa-favorite-order'),'refresh stable');return true;")
    # 图包词条在收藏墙里沿用来源册的「点卡看图」；只有选择模式才拦下主点击。
    test('pack favorite keeps view-on-click and selection intercepts controls', """
      qa.s.favSource='nai45_community_pack';qa.app.applyFilter({transition:'none'});
      assert(qa.s.list.length>0&&qa.s.list[0]._srcType==='pack','pack fixture');
      let copied=0,opened=0;
      qa.masonry.setMasonryActions({copyEntry:()=>copied++,openLightbox:()=>opened++});
      try{
        document.querySelector('.card').click(); assert(opened===1&&copied===0,'favorite pack main click opens image');
        [...document.querySelectorAll('.favorites-desktop-controls button')].find(b=>b.textContent==='选择').click();
        document.querySelector('.card .fav-btn').click();
        assert(opened===1&&copied===0&&qa.s.favSelected.size===1,'selection stops star and open');
      }finally{qa.masonry.setMasonryActions({copyEntry:qa.copy.copyEntry,openLightbox:qa.lightbox.openLightbox});}
      [...document.querySelectorAll('#favoritesBatchBar button')].find(b=>b.textContent==='完成').click();
      await new Promise(r=>setTimeout(r,200));qa.s.favSource='';qa.app.applyFilter({transition:'none'});return true;
    """)
    test('permission counts agree across rail header and organizer', """
      qa.s.allowNsfw=true;
      const adultBook=await qa.data.fetchCodex(qa.s.codexes.find(c=>c.id==='suozhang_r18'));
      const adult=adultBook.entries.find(e=>(e.image||e.images?.length)&&!e.path.some(p=>/R18G|重口/i.test(p)));
      assert(adult,'real restricted fixture');
      await qa.store.commitLibrary(d=>qa.core.addLibraryItem(d,'suozhang_r18:'+adult.id,{codexes:qa.s.codexes}));
      await qa.app.openFavoritesView({historyMode:'replace',transition:'none'});
      const all=qa.s.codex.entries.map(qa.fav.favKey);
      const outcome=await qa.store.commitLibrary(d=>{const f=qa.core.createFolder(d,'计数核验');qa.core.setFolderMembership(d,all,f.id,true);return f.id;});
      qa.s.allowNsfw=false;qa.s.favFolder=outcome.result;qa.app.applyFilter({transition:'none'});
      const expected=qa.s.codex.entries.filter(e=>!qa.access.isEntryAccessBlocked(e)&&!qa.blocking.isContentBlocked(e)).length;
      assert(expected<all.length,'fixture must actually contain permission-hidden content');
      assert(expected===qa.s.list.length,'permission list');
      assert(qa.view.countVisible(all)===expected,'permission helper');
      assert(document.querySelector('[data-folder-id="'+outcome.result+'"] .favorites-count').textContent===String(expected),'permission folder count');
      assert(document.querySelector('#favoritesHeader .favorites-count').textContent===expected+' 项','permission header count');
      await qa.view.openOrganize([qa.fav.favKey(qa.s.list[0])]);
      const row=document.querySelector('[data-folder-check="'+outcome.result+'"]');
      assert(row.querySelector('.favorites-count').textContent===String(expected),'permission organize count');
      return {stored:all.length,visible:expected};
    """)
    test('organize from atlas toast keeps live folder counts after writes', """
      document.querySelector('#favoritesOrganize .favorites-dialog-footer button').click();
      await new Promise(r=>setTimeout(r,180));
      await qa.app.loadCodex('suozhang',{historyMode:'replace',transition:'none'});
      const entry=qa.s.codex.entries.find(e=>!qa.fav.isFav(e)); assert(entry,'new atlas favorite fixture');
      await qa.fav.toggleFav(entry);
      document.querySelector('#toast .toast-action').click();await new Promise(r=>setTimeout(r,250));
      assert(!document.querySelector('#favoritesOrganize').hidden,'toast organize opens');
      document.querySelector('#favoritesOrganizeName').value='图鉴整理核验';
      document.querySelector('.favorites-organize-new').requestSubmit();await new Promise(r=>setTimeout(r,250));
      const folder=qa.store.librarySnapshot().folders.find(f=>f.name==='图鉴整理核验');
      const row=document.querySelector('[data-folder-check="'+folder.id+'"]');
      assert(row?.querySelector('.favorites-count').textContent==='1','new membership keeps visible count');
      assert([...document.querySelectorAll('.favorites-organize-row .favorites-count')].some(n=>Number(n.textContent)>=400),'other folder count preserved');
      return {count:row.querySelector('.favorites-count').textContent};
    """)
    test('actual browser quota rejects new favorite without changing star or data', """
      document.querySelector('#favoritesOrganize .favorites-dialog-footer button').click();
      await new Promise(r=>setTimeout(r,180));
      const entry=qa.s.codex.entries.find(e=>!qa.fav.isFav(e)); assert(entry,'unstarred fixture');
      const key=qa.fav.favKey(entry),bytes=localStorage.getItem('fadian-favs-v2');
      const button=document.createElement('button'); button.textContent='☆';
      const filler='qa-favorites-quota-fill'; let low=0,high=8*1024*1024;
      try {
        while(low<high){
          const size=Math.ceil((low+high)/2);
          try{localStorage.setItem(filler,'x'.repeat(size));low=size;}
          catch(error){if(error.name!=='QuotaExceededError')throw error;high=size-1;}
        }
        localStorage.setItem(filler,'x'.repeat(low));
        const outcome=await qa.fav.toggleFav(entry,button);
        assert(!outcome.ok&&outcome.reason==='quota','real quota must reject add');
        assert(!qa.s.favs.has(key)&&!qa.fav.isFav(entry),'failed add stays absent');
        assert(button.textContent==='☆'&&!button.classList.contains('on'),'failed add keeps star');
        assert(localStorage.getItem('fadian-favs-v2')===bytes,'failed add keeps disk');
        assert(document.querySelector('#toast').textContent.includes('浏览器存储已满'),'failure feedback');
        return {fillerCodeUnits:low,reason:outcome.reason};
      } finally { localStorage.removeItem(filler); }
    """)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True, help='工作区预览配置中的回环地址')
    parser.add_argument('--out-dir', default=str(ROOT/'output'/'favorites-v2-validation'/'integration'))
    args = parser.parse_args()
    preview_url = urlsplit(args.base_url)
    if preview_url.scheme != 'http' or preview_url.hostname not in ('localhost', '127.0.0.1') or preview_url.username or preview_url.password:
        parser.error('只允许回环预览地址')
    out = Path(args.out_dir).resolve(); out.mkdir(parents=True, exist_ok=True)
    preview = chrome = cdp = None
    try:
        preview = ui.start_preview(args.base_url)
        port = ui.find_free_port(); run.debug_base = f'http://127.0.0.1:{port}'
        chrome = ui.start_chrome(out, port)
        cdp = ui.CDP(ui.page_ws_url(port))
        results = run(args.base_url.rstrip('/')+'/', out, cdp)
        ui.write_report(out, args.base_url, results)
        print('PASS: '+str(len(results))+' browser checks')
        return 0
    except Exception:
        (out/'fatal.txt').write_text(traceback.format_exc(), encoding='utf-8')
        print(traceback.format_exc())
        return 1
    finally:
        if cdp: cdp.close()
        if chrome: chrome.terminate()
        if preview: preview.terminate()


if __name__ == '__main__':
    raise SystemExit(main())
