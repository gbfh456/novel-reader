const { chromium } = require('playwright');
const EXE='/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB='/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const results=[]; const check=(n,ok,x='')=>{results.push({n,ok});console.log(ok?'✓':'✗',n,x)};
(async()=>{
  const browser=await chromium.launch({executablePath:EXE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader'],env:{...process.env,LD_LIBRARY_PATH:LIB,FONTCONFIG_FILE:'/tmp/fontconf/fonts.conf'}});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message.slice(0,150)));
  await page.route('**/api/plugins/fanqie-bridge/fetch-batch', async route=>{
    const body=route.request().postDataJSON();
    await new Promise(r=>setTimeout(r,300));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,results:(body.requests||[]).map(r=>({ok:true,status:200,finalUrl:r.url,headers:{},charset:'utf-8',text:`<div id="content"><p>第${String(r.url).split('/').pop()}章</p></div>`}))})});
  });
  await page.route('**/api/plugins/fanqie-bridge/fetch', async route=>{
    const body=route.request().postDataJSON();
    await new Promise(r=>setTimeout(r,300));
    const text = body.url.includes('/s?') ? '<div class="result"><h3><a href="https://f.test/b/1">长书</a></h3></div>'
      : body.url.includes('/toc') ? `<ul class="list">${Array.from({length:200},(_,i)=>`<li><a href="https://f.test/c/${i+1}">第${i+1}章</a></li>`).join('')}</ul>`
      : body.url.includes('/c/') ? `<div id="content"><p>第${body.url.split('/').pop()}章</p></div>`
      : '<h1>长书</h1><a class="toc" href="https://f.test/b/1/toc">目录</a>';
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,status:200,finalUrl:body.url,headers:{},text,charset:'utf-8',elapsed:1})});
  });
  await page.goto('http://127.0.0.1:8899/dev/harness-browser.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__harnessReady===true);
  await page.click('#nr-orb'); await page.waitForSelector('#nr-panel.nr-open');
  await page.evaluate(()=>{
    window.NovelReader.setOnlineSettings({searchEngine:'source',channel:'auto',concurrency:6,respectRateLimit:false});
    window.NovelReader.importSourcesJson(JSON.stringify([{
      bookSourceName:'长书源',bookSourceUrl:'https://f.test',
      searchUrl:'https://f.test/s?q={{key}}',
      ruleSearch:{bookList:'class.result',name:'tag.a@text',bookUrl:'tag.a@href'},
      ruleBookInfo:{name:'tag.h1@text',tocUrl:'class.toc@href'},
      ruleToc:{chapterList:'class.list@tag.li',chapterName:'tag.a@text',chapterUrl:'tag.a@href'},
      ruleContent:{content:'#content@html'},
    }]));
  });
  await page.evaluate(async()=>{ await window.NovelReader.searchOnline('x'); await window.NovelReader.openOnlineUrl('https://f.test/b/1'); });
  await page.evaluate(()=>window.NovelReader.openTab('online'));
  await page.evaluate(()=>{ window.__downloadPromise = window.NovelReader.downloadOnline(); });
  await page.waitForTimeout(900);
  const stopVisible = await page.locator('#nr-ol-book [data-act="stop"]').count();
  check('下载卡片上有「停止下载」按钮', stopVisible===1);
  const t0=Date.now();
  await page.click('#nr-ol-book [data-act="stop"]');
  const meta = await page.evaluate(async()=>{ const m = await window.__downloadPromise; return m? {count:m.chapterCount,title:m.title} : null; });
  const elapsed=Date.now()-t0;
  check('点停止后很快结束（<5 秒）', elapsed < 5000, `elapsed=${Math.round(elapsed)}ms`);
  check('已抓到的章节保留下来', meta && meta.count > 0 && meta.count < 200, JSON.stringify(meta));

  const progressText = await page.evaluate(()=>document.querySelector('.nr-online-progress-text')?.textContent || '');
  check('停不下来时也不会一直显示「正在抓取」', !/^正在抓取/.test(progressText), progressText.slice(0,60));
  check('无页面错误', errors.length===0, errors.slice(0,2).join(' | '));
  await browser.close();
  const failed=results.filter(r=>!r.ok);
  console.log(`\n结果：${results.length-failed.length}/${results.length} 通过`);
  if(failed.length) process.exit(1);
})().catch(e=>{console.error('FAIL',e.message.slice(0,400));process.exit(1)});
