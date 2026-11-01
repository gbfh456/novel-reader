const { chromium } = require('playwright');
const EXE='/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB='/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const results=[]; const check=(n,ok,x='')=>{results.push({n,ok});console.log(ok?'✓':'✗',n,x)};
(async()=>{
  const browser=await chromium.launch({executablePath:EXE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader'],env:{...process.env,LD_LIBRARY_PATH:LIB,FONTCONFIG_FILE:'/tmp/fontconf/fonts.conf'}});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message.slice(0,150)));
  let singles=0;
  await page.route('**/api/plugins/fanqie-bridge/fetch-batch', route=>route.fulfill({status:404,contentType:'text/html',body:'<pre>Not Found</pre>'}));
  await page.route('**/api/plugins/fanqie-bridge/fetch', async route=>{
    singles++;
    const body=route.request().postDataJSON();
    const text = body.url.includes('/s?') ? '<div class="result"><h3><a href="https://f.test/b/1">旧桥书</a></h3></div>'
      : body.url.includes('/toc') ? '<ul class="list"><li><a href="https://f.test/c/1">第1章</a></li><li><a href="https://f.test/c/2">第2章</a></li></ul>'
      : body.url.includes('/c/') ? `<div id="content"><p>第${body.url.split('/').pop()}章正文。</p></div>`
      : '<h1>旧桥书</h1><a class="toc" href="https://f.test/b/1/toc">目录</a>';
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,status:200,finalUrl:body.url,headers:{},text,charset:'utf-8',elapsed:1})});
  });
  await page.goto('http://127.0.0.1:8899/dev/harness-browser.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__harnessReady===true);
  await page.click('#nr-orb'); await page.waitForSelector('#nr-panel.nr-open');
  await page.evaluate(()=>{
    window.NovelReader.setOnlineSettings({searchEngine:'source',channel:'auto',concurrency:4});
    window.NovelReader.importSourcesJson(JSON.stringify([{bookSourceName:'旧源',bookSourceUrl:'https://f.test',searchUrl:'https://f.test/s?q={{key}}',ruleSearch:{bookList:'class.result',name:'tag.a@text',bookUrl:'tag.a@href'},ruleBookInfo:{name:'tag.h1@text',tocUrl:'class.toc@href'},ruleToc:{chapterList:'class.list@tag.li',chapterName:'tag.a@text',chapterUrl:'tag.a@href'},ruleContent:{content:'#content@html'}}]));
  });
  const opened = await page.evaluate(async()=>{ await window.NovelReader.searchOnline('x'); return await window.NovelReader.openOnlineUrl('https://f.test/b/1'); });
  check('老桥接（无 /fetch-batch）仍能打开书', opened?.chapters===2, JSON.stringify(opened));
  const meta = await page.evaluate(async()=>{ const m=await window.NovelReader.downloadOnline(); return m? {n:m.chapterCount}:null; });
  check('老桥接仍能下载（退化逐章）', meta?.n===2, JSON.stringify(meta));
  check('逐章请求确实发生了', singles>=4, 'singles='+singles);
  check('无页面错误', errors.length===0, errors.slice(0,2).join(' | '));
  await browser.close();
  const failed=results.filter(r=>!r.ok);
  console.log(`\n结果：${results.length-failed.length}/${results.length} 通过`);
  if(failed.length) process.exit(1);
})().catch(e=>{console.error('FAIL',e.message.slice(0,400));process.exit(1)});
