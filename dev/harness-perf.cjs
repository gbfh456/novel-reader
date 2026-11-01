const { chromium } = require('playwright');
const EXE='/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB='/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const results=[]; const check=(n,ok,x='')=>{results.push({n,ok});console.log(ok?'✓':'✗',n,x)};
(async()=>{
  const browser=await chromium.launch({executablePath:EXE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader'],env:{...process.env,LD_LIBRARY_PATH:LIB,FONTCONFIG_FILE:'/tmp/fontconf/fonts.conf'}});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message.slice(0,150)));
  let inflight=0, peak=0, fetches=0;
  await page.route('**/api/plugins/fanqie-bridge/fetch', async route=>{
    const body=route.request().postDataJSON();
    fetches++;
    if (body.url.includes('/c/')) {
      inflight++; peak=Math.max(peak,inflight);
      await new Promise(r=>setTimeout(r,60));
      inflight--;
      const n=body.url.split('/').pop();
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,status:200,finalUrl:body.url,headers:{},text:`<div id="content"><p>第${n}章正文。</p></div>`,charset:'utf-8',elapsed:1})});
      return;
    }
    const toc = Array.from({length: 40}, (_, i)=>`<li><a href="https://f.test/c/${i+1}">第${i+1}章</a></li>`).join('');
    const text = body.url.includes('/s?') ? '<div class="result"><h3><a href="https://f.test/b/1">连更书</a></h3></div>'
      : body.url.includes('/toc') ? `<ul class="list">${toc}</ul>`
      : '<h1>连更书</h1><a class="toc" href="https://f.test/b/1/toc">目录</a>';
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,status:200,finalUrl:body.url,headers:{},text,charset:'utf-8',elapsed:1})});
  });
  await page.goto('http://127.0.0.1:8899/dev/harness-browser.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__harnessReady===true);
  await page.click('#nr-orb'); await page.waitForSelector('#nr-panel.nr-open');

  await page.evaluate(()=>{
    window.NovelReader.setOnlineSettings({searchEngine:'source',channel:'auto',concurrency:6,respectRateLimit:false});
    window.NovelReader.importSourcesJson(JSON.stringify([{
      bookSourceName:'并发源',bookSourceUrl:'https://f.test',
      concurrentRate:'1/1000',
      searchUrl:'https://f.test/s?q={{key}}',
      ruleSearch:{bookList:'class.result',name:'tag.a@text',bookUrl:'tag.a@href'},
      ruleBookInfo:{name:'tag.h1@text',tocUrl:'class.toc@href'},
      ruleToc:{chapterList:'class.list@tag.li',chapterName:'tag.a@text',chapterUrl:'tag.a@href'},
      ruleContent:{content:'#content@html'},
    }]));
  });
  const opened = await page.evaluate(async()=>await window.NovelReader.openOnlineUrl('https://f.test/b/1'));
  check('目录 40 章', opened?.chapters===40, JSON.stringify(opened));

  // 并发：源写了 1/1000（一秒一章），关掉遵从后应并发 6
  const started=Date.now();
  const saved = await page.evaluate(async()=>{
    const t0=performance.now();
    const meta = await window.NovelReader.downloadOnline();
    return { ms: performance.now()-t0, meta: meta ? {id: meta.id, chapterCount: meta.chapterCount} : null };
  });
  const elapsed=Date.now()-started;
  check('40 章下载完成', saved.meta && saved.meta.chapterCount===40, JSON.stringify(saved.meta));
  check('并发确实 > 1（书源写 1/1000 也不该一秒一章）', peak>=3, `peak=${peak} elapsed=${Math.round(elapsed)}ms fetches=${fetches}`);
  check('下载速度合理（40 章 < 8 秒）', elapsed < 8000, `elapsed=${Math.round(elapsed)}ms`);

  // 保存后章节正文齐全（分批写入）
  const stored = await page.evaluate(async (id)=>{
    const db = await import('/js/db.js');
    const list = await db.getChapterList(id);
    const first = await db.getChapterContent(id, 0);
    const last = await db.getChapterContent(id, 39);
    return { count:list.length, first:first.slice(0,12), last:last.slice(0,12) };
  }, saved.meta.id);
  check('章节与正文都落库（含最后一章）', stored.count===40 && stored.first.includes('第1章') && stored.last.includes('第40章'), JSON.stringify(stored));

  // 阅读页换源按钮
  await page.click('#nr-panel .nr-tab[data-tab="library"]');
  await page.waitForTimeout(300);
  await page.locator('.nr-book-card').first().click();
  await page.waitForSelector('#nr-article:not([hidden])');
  const btn = await page.locator('#nr-reader-change-source').isVisible();
  check('阅读页有换源按钮', btn===true);

  // 转码失败识别
  const apiErr = await page.evaluate(async()=>{
    const { describeApiError } = await import('/js/book/pipeline.js');
    return describeApiError('{"code":1001,"message":"转码失败"}');
  });
  check('错误 JSON 会被识别成站点错误', /转码失败/.test(apiErr) && /登录|Cookie|失效/.test(apiErr), apiErr);

  check('无页面错误', errors.length===0, errors.slice(0,2).join(' | '));
  await browser.close();
  const failed=results.filter(r=>!r.ok);
  console.log(`\n结果：${results.length-failed.length}/${results.length} 通过`);
  if(failed.length) process.exit(1);
})().catch(e=>{console.error('FAIL',e.message.slice(0,400));process.exit(1)});
