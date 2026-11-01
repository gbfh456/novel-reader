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
    await new Promise(r=>setTimeout(r,250));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,results:(body.requests||[]).map(r=>({ok:true,status:200,finalUrl:r.url,headers:{},charset:'utf-8',text:`<div id="content"><p>第${String(r.url).split('/').pop()}章</p></div>`}))})});
  });
  await page.route('**/api/plugins/fanqie-bridge/fetch', async route=>{
    const body=route.request().postDataJSON();
    const slowSearch = body.url.includes('/s?');
    await new Promise(r=>setTimeout(r, slowSearch ? 2500 : 120));
    const text = slowSearch ? '<div class="result"><h3><a href="https://f.test/b/1">书</a></h3></div>'
      : body.url.includes('/toc') ? `<ul class="list">${Array.from({length:120},(_,i)=>`<li><a href="https://f.test/c/${i+1}">第${i+1}章</a></li>`).join('')}</ul>`
      : body.url.includes('/c/') ? `<div id="content"><p>第${body.url.split('/').pop()}章</p></div>`
      : '<h1>书</h1><a class="toc" href="https://f.test/b/1/toc">目录</a>';
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,status:200,finalUrl:body.url,headers:{},text,charset:'utf-8',elapsed:1})});
  });
  await page.goto('http://127.0.0.1:8899/dev/harness-browser.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__harnessReady===true);
  await page.click('#nr-orb'); await page.waitForSelector('#nr-panel.nr-open');
  await page.evaluate(()=>{
    window.NovelReader.setOnlineSettings({searchEngine:'source',channel:'auto',concurrency:8});
    window.NovelReader.importSourcesJson(JSON.stringify([{bookSourceName:'双源',bookSourceUrl:'https://f.test',searchUrl:'https://f.test/s?q={{key}}',ruleSearch:{bookList:'class.result',name:'tag.a@text',bookUrl:'tag.a@href'},ruleBookInfo:{name:'tag.h1@text',tocUrl:'class.toc@href'},ruleToc:{chapterList:'class.list@tag.li',chapterName:'tag.a@text',chapterUrl:'tag.a@href'},ruleContent:{content:'#content@html'}}]));
  });
  await page.evaluate(async()=>{ await window.NovelReader.searchOnline('x'); await window.NovelReader.openOnlineUrl('https://f.test/b/1'); });
  await page.evaluate(()=>window.NovelReader.openTab('online'));

  // 1) 下载中，点「搜索停止」不应影响下载
  await page.evaluate(()=>{ window.__dl = window.NovelReader.downloadOnline(); });
  await page.waitForTimeout(500);
  const searchStopVisible = await page.locator('#nr-ol-stop').isVisible().catch(()=>false);
  check('搜索停止按钮在下载时隐藏（两者分开）', searchStopVisible===false);
  const after = await page.evaluate(async()=>{ const m = await window.__dl; return m? m.chapterCount : 0; });
  check('没有误停：下载完成 120 章', after===120, 'chapters='+after);

  // 2) 搜索中，点「下载停止」不应影响搜索
  await page.evaluate(()=>{ window.__search = window.NovelReader.searchOnline('y'); });
  await page.waitForTimeout(150);
  const stopBtnCount = await page.locator('#nr-ol-book [data-act="stop"]').count();
  check('下载未进行时没有下载停止按钮', stopBtnCount===0);
  const searchResult = await page.evaluate(async()=>{ const r = await window.__search; return r.length; });
  check('搜索自行完成，没被打断', searchResult===1, 'results='+searchResult);

  // 3) 搜索中，搜索停止按钮可用且只停搜索
  await page.evaluate(()=>window.NovelReader.openTab('online'));
  await page.evaluate(()=>{ window.__search2 = window.NovelReader.searchOnline('z'); });
  await page.waitForTimeout(120);
  const visible = await page.locator('#nr-ol-stop').isVisible();
  check('搜索中显示搜索停止按钮', visible===true);
  await page.click('#nr-ol-stop');
  await page.waitForTimeout(400);
  const status = await page.evaluate(()=>document.querySelector('#nr-ol-status')?.textContent||'');
  check('搜索停止只提示停止搜索', /停止搜索/.test(status), status.slice(0,40));

  check('无页面错误', errors.length===0, errors.slice(0,2).join(' | '));
  await browser.close();
  const failed=results.filter(r=>!r.ok);
  console.log(`\n结果：${results.length-failed.length}/${results.length} 通过`);
  if(failed.length) process.exit(1);
})().catch(e=>{console.error('FAIL',e.message.slice(0,400));process.exit(1)});
