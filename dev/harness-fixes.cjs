/**
 * 浏览器回归脚本（需要在扩展目录起静态服务：python3 -m http.server 8899，
 * 并用带 CJK 字体的 Chromium 运行；详见 PLAN-Legado-Max.md 的联调记录）。
 */
const { chromium } = require('playwright');
const EXE='/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB='/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const URL='http://127.0.0.1:8899/dev/harness-browser.html';
const results=[]; const check=(n,ok,x='')=>{results.push({n,ok});console.log(ok?'✓':'✗',n,x)};

function contrast(a,b){ // rgb arrays
  const lum=c=>{const [r,g,bl]=c.map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*r+0.7152*g+0.0722*bl};
  const l1=lum(a),l2=lum(b); const [hi,lo]=l1>l2?[l1,l2]:[l2,l1];
  return (hi+0.05)/(lo+0.05);
}
const parse=s=>{const m=String(s).match(/rgba?\(([^)]+)\)/); if(!m) {const m2=String(s).match(/color\(srgb ([^)]+)\)/); if(!m2) return null; return m2[1].split(/[\s\/]+/).filter(Boolean).slice(0,3).map(v=>Math.round(parseFloat(v)*255));} return m[1].split(',').slice(0,3).map(v=>parseFloat(v));};

(async()=>{
  const browser=await chromium.launch({executablePath:EXE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader'],env:{...process.env,LD_LIBRARY_PATH:LIB,FONTCONFIG_FILE:'/tmp/fontconf/fonts.conf'}});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message.slice(0,150)));
  let bridgeMode='ok';
  await page.route('**/api/plugins/fanqie-bridge/fetch', async route=>{
    const body=route.request().postDataJSON();
    if (bridgeMode==='500') return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({ok:false,error:'上游站点返回 500（夹具）'})});
    const text = body.url.includes('/s?')
      ? '<div class="result"><h3><a href="https://f.test/b/1">甲</a></h3></div>'
      : body.url.includes('/toc')
        ? '<ul class="list"><li><a href="https://f.test/c/1">第1章</a></li><li><a href="https://f.test/c/2">第2章</a></li></ul>'
        : '<h1>甲书</h1><a class="toc" href="https://f.test/b/1/toc">目录</a>';
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,status:200,finalUrl:body.url,headers:{},text,charset:'utf-8',elapsed:1})});
  });
  await page.goto(URL,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__harnessReady===true);
  await page.click('#nr-orb'); await page.waitForSelector('#nr-panel.nr-open');

  // 1) 搜索未结束时可打开结果
  const openDuringSearch = await page.evaluate(async()=>{
    window.NovelReader.setOnlineSettings({searchEngine:'source',channel:'auto'});
    window.NovelReader.importSourcesJson(JSON.stringify([{bookSourceName:'慢源',bookSourceUrl:'https://f.test',searchUrl:'https://f.test/s?q={{key}}',ruleSearch:{bookList:'class.result',name:'tag.a@text',bookUrl:'tag.a@href'},ruleBookInfo:{name:'tag.h1@text',tocUrl:'class.toc@href'},ruleToc:{chapterList:'class.list@tag.li',chapterName:'tag.a@text',chapterUrl:'tag.a@href'},ruleContent:{content:'#content@html'}}]));
    const searchPromise=window.NovelReader.searchOnline('测试');   // 不等它
    await new Promise(r=>setTimeout(r,80));
    const opened=await window.NovelReader.openOnlineUrl('https://f.test/b/1');
    await searchPromise.catch(()=>null);
    return {opened};
  });
  check('搜索未结束时能打开结果', Boolean(openDuringSearch.opened), JSON.stringify(openDuringSearch).slice(0,80));

  // 2) 主题对比度
  await page.evaluate(async()=>{await window.NovelReader.importText('主题书','第1章 a\n正文。\n第2章 b\n正文二。');});
  await page.waitForTimeout(400);
  await page.click('#nr-panel .nr-tab[data-tab="library"]');
  await page.locator('.nr-book-card').first().click();
  await page.waitForSelector('#nr-article:not([hidden])');
  const themeReport={};
  for (const theme of ['paper','sepia','green','dark']) {
    await page.click('#nr-reader-settings-btn');
    await page.selectOption('#nr-reader-theme',theme);
    await page.waitForTimeout(250);
    await page.click('#nr-reader-settings-btn');
    themeReport[theme]=await page.evaluate(()=>{
      const parseColor=v=>{
        const m=String(v).match(/rgba?\(([^)]+)\)/);
        if(m){const p=m[1].split(',').map(Number); return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1};}
        const m2=String(v).match(/color\(srgb ([^)]+)\)/);
        if(m2){const p=m2[1].split(/[\s\/]+/).filter(Boolean).map(Number); return {r:p[0]*255,g:p[1]*255,b:p[2]*255,a:p.length>3?p[3]:1};}
        return null;
      };
      // 从根往下逐层合成，得到元素真实看到的底色
      const effectiveBg=el=>{
        const chain=[]; let n=el;
        while(n){ chain.push(n); n=n.parentElement; }
        let base={r:255,g:255,b:255,a:1};
        for(const node of chain.reverse()){
          const c=parseColor(getComputedStyle(node).backgroundColor);
          if(!c||c.a===0) continue;
          base={ r:c.r*c.a+base.r*(1-c.a), g:c.g*c.a+base.g*(1-c.a), b:c.b*c.a+base.b*(1-c.a), a:1 };
        }
        return base;
      };
      const pick=s=>document.querySelector(s);
      const els={chapterCount:pick('.nr-chapter-count'), pageInfo:pick('#nr-page-info'), footerBtn:pick('#nr-chapter-prev')};
      const out={};
      for(const [k,el] of Object.entries(els)){
        if(!el) continue;
        const fg=parseColor(getComputedStyle(el).color);
        const bg=effectiveBg(el);
        out[k]={fg:[fg.r,fg.g,fg.b], bg:[bg.r,bg.g,bg.b]};
      }
      return out;
    });
  }
  for (const [theme,data] of Object.entries(themeReport)) {
    const bad=[];
    for (const [key,val] of Object.entries(data)) {
      const fg=val.fg, bg=val.bg;
      if(!fg||!bg) continue;
      const ratio=contrast(fg,bg);
      if (ratio < 4.5) bad.push(`${key}=${ratio.toFixed(2)}`);
    }
    check(`${theme} 主题文字对比度 ≥4.5`, bad.length===0, bad.join(', '));
  }

  // 3) 桥接 500 时不再显示「酒馆网页通道返回 500」
  bridgeMode='500';
  const err=await page.evaluate(async()=>{
    try { await window.NovelReader.openOnlineUrl('https://f.test/b/2'); return 'no-error'; }
    catch(e){ return e.message; }
  });
  const status=await page.evaluate(()=>document.querySelector('#nr-ol-status')?.textContent || '');
  check('桥接 500 显示真实原因', /桥接/.test(err+status) && !/酒馆网页通道返回 500/.test(err+status), (err+' | '+status).slice(0,80));

  check('无页面错误', errors.length===0, errors.slice(0,2).join(' | '));
  await browser.close();
  const failed=results.filter(r=>!r.ok);
  console.log(`\n结果：${results.length-failed.length}/${results.length} 通过`);
  if(failed.length) process.exit(1);
})().catch(e=>{console.error('FAIL',e.message.slice(0,400));process.exit(1)});
