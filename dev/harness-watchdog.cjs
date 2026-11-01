const { chromium } = require('playwright');
const EXE='/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB='/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const results=[]; const check=(n,ok,x='')=>{results.push({n,ok});console.log(ok?'✓':'✗',n,x)};
(async()=>{
  const browser=await chromium.launch({executablePath:EXE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader'],env:{...process.env,LD_LIBRARY_PATH:LIB,FONTCONFIG_FILE:'/tmp/fontconf/fonts.conf'}});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message.slice(0,150)));
  await page.route('**/api/plugins/fanqie-bridge/fetch', async route=>{
    const body=route.request().postDataJSON();
    if (body.url.includes('/c/3')) { await new Promise(r=>setTimeout(r,4000)); return route.abort().catch(()=>{}); }
    const text = body.url.includes('/s?') ? '<div class="result"><h3><a href="https://f.test/b/1">慢章书</a></h3></div>'
      : body.url.includes('/toc') ? '<ul class="list"><li><a href="https://f.test/c/1">第1章</a></li><li><a href="https://f.test/c/2">第2章</a></li><li><a href="https://f.test/c/3">第3章</a></li></ul>'
      : '<h1>慢章书</h1><a class="toc" href="https://f.test/b/1/toc">目录</a>';
    if (body.url.includes('/c/')) {
      const n=body.url.split('/').pop();
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,status:200,finalUrl:body.url,headers:{},text:`<div id="content"><p>第${n}章</p></div>`,charset:'utf-8',elapsed:1})});
    }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,status:200,finalUrl:body.url,headers:{},text,charset:'utf-8',elapsed:1})});
  });
  await page.goto('http://127.0.0.1:8899/dev/harness-browser.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__harnessReady===true);
  await page.click('#nr-orb'); await page.waitForSelector('#nr-panel.nr-open');
  await page.evaluate(()=>{
    window.NovelReader.setOnlineSettings({searchEngine:'source',channel:'auto',concurrency:2,chapterTimeoutMs:5000,respectRateLimit:false});
    window.NovelReader.importSourcesJson(JSON.stringify([{
      bookSourceName:'慢章源',bookSourceUrl:'https://f.test',
      searchUrl:'https://f.test/s?q={{key}}',
      ruleSearch:{bookList:'class.result',name:'tag.a@text',bookUrl:'tag.a@href'},
      ruleBookInfo:{name:'tag.h1@text',tocUrl:'class.toc@href'},
      ruleToc:{chapterList:'class.list@tag.li',chapterName:'tag.a@text',chapterUrl:'tag.a@href'},
      ruleContent:{content:'#content@html'},
    }]));
  });
  await page.evaluate(async()=>await window.NovelReader.openOnlineUrl('https://f.test/b/1'));
  const t0=Date.now();
  const res = await page.evaluate(async()=>{
    const t=performance.now();
    const meta = await window.NovelReader.downloadOnline();
    return { ms: performance.now()-t, meta: meta? {chapterCount: meta.chapterCount}:null };
  });
  const elapsed=Date.now()-t0;
  check('有一章卡住时不会拖死整本', elapsed < 15000, `elapsed=${Math.round(elapsed)}ms`);
  check('其它章节仍然保存', res.meta && res.meta.chapterCount===2, JSON.stringify(res.meta));
  check('无页面错误', errors.length===0, errors.slice(0,2).join(' | '));
  await browser.close();
  const failed=results.filter(r=>!r.ok);
  console.log(`\n结果：${results.length-failed.length}/${results.length} 通过`);
  if(failed.length) process.exit(1);
})().catch(e=>{console.error('FAIL',e.message.slice(0,400));process.exit(1)});
