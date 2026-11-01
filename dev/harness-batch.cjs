const { chromium } = require('playwright');
const EXE='/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB='/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const results=[]; const check=(n,ok,x='')=>{results.push({n,ok});console.log(ok?'✓':'✗',n,x)};
(async()=>{
  const browser=await chromium.launch({executablePath:EXE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader'],env:{...process.env,LD_LIBRARY_PATH:LIB,FONTCONFIG_FILE:'/tmp/fontconf/fonts.conf'}});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message.slice(0,150)));
  let batchCalls=0, singleCalls=0, siteLatency=250;
  await page.route('**/api/plugins/fanqie-bridge/fetch-batch', async route=>{
    batchCalls++;
    const body=route.request().postDataJSON();
    // 模拟站点 250ms 延迟
    await new Promise(r=>setTimeout(r, siteLatency));
    const results = (body.requests||[]).map(req=>{
      const n=String(req.url).split('/').pop();
      return { ok:true, status:200, finalUrl:req.url, headers:{}, charset:'utf-8', text:`<div id="content"><p>第${n}章正文。</p></div>` };
    });
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,results})});
  });
  await page.route('**/api/plugins/fanqie-bridge/fetch', async route=>{
    singleCalls++;
    const body=route.request().postDataJSON();
    await new Promise(r=>setTimeout(r, siteLatency));
    const text = body.url.includes('/s?') ? '<div class="result"><h3><a href="https://f.test/b/1">批书</a></h3></div>'
      : body.url.includes('/toc') ? `<ul class="list">${Array.from({length:60},(_,i)=>`<li><a href="https://f.test/c/${i+1}">第${i+1}章</a></li>`).join('')}</ul>`
      : body.url.includes('/c/') ? `<div id="content"><p>第${body.url.split('/').pop()}章正文。</p></div>`
      : '<h1>批书</h1><a class="toc" href="https://f.test/b/1/toc">目录</a>';
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,status:200,finalUrl:body.url,headers:{},text,charset:'utf-8',elapsed:1})});
  });
  await page.goto('http://127.0.0.1:8899/dev/harness-browser.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__harnessReady===true);
  await page.click('#nr-orb'); await page.waitForSelector('#nr-panel.nr-open');
  await page.evaluate(()=>{
    window.NovelReader.setOnlineSettings({searchEngine:'source',channel:'auto',concurrency:6,respectRateLimit:false,chapterTimeoutMs:20000});
    window.NovelReader.importSourcesJson(JSON.stringify([{
      bookSourceName:'批量源',bookSourceUrl:'https://f.test',
      searchUrl:'https://f.test/s?q={{key}}',
      ruleSearch:{bookList:'class.result',name:'tag.a@text',bookUrl:'tag.a@href'},
      ruleBookInfo:{name:'tag.h1@text',tocUrl:'class.toc@href'},
      ruleToc:{chapterList:'class.list@tag.li',chapterName:'tag.a@text',chapterUrl:'tag.a@href'},
      ruleContent:{content:'#content@html'},
    }]));
  });
  await page.evaluate(async()=>await window.NovelReader.openOnlineUrl('https://f.test/b/1'));
  const t0=Date.now();
  const res=await page.evaluate(async()=>{
    const t=performance.now();
    const meta=await window.NovelReader.downloadOnline();
    return {ms:performance.now()-t, count:meta?meta.chapterCount:0};
  });
  const elapsed=Date.now()-t0;
  check('60 章全部下完', res.count===60, JSON.stringify(res));
  check('走了批量接口', batchCalls>0, `batch=${batchCalls} single=${singleCalls}`);
  check('浏览器往返次数大幅减少', batchCalls <= 40, `batch=${batchCalls}`);
  check('速度明显提升（60 章 < 6 秒）', elapsed < 6000, `elapsed=${Math.round(elapsed)}ms`);
  const stored = await page.evaluate(async ()=>{
    const db=await import('/js/db.js');
    const list=await db.listNovels();
    const chapters=await db.getChapterList(list[0].id);
    return {count:chapters.length, last:(await db.getChapterContent(list[0].id, 59)).slice(0,10)};
  });
  check('最后一章也落库', stored.count===60 && /第60章/.test(stored.last), JSON.stringify(stored));
  check('无页面错误', errors.length===0, errors.slice(0,2).join(' | '));
  await browser.close();
  const failed=results.filter(r=>!r.ok);
  console.log(`\n结果：${results.length-failed.length}/${results.length} 通过`);
  if(failed.length) process.exit(1);
})().catch(e=>{console.error('FAIL',e.message.slice(0,400));process.exit(1)});
