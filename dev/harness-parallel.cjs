const { chromium } = require('playwright');
const EXE='/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB='/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const results=[]; const check=(n,ok,x='')=>{results.push({n,ok});console.log(ok?'✓':'✗',n,x)};
(async()=>{
  const browser=await chromium.launch({executablePath:EXE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader'],env:{...process.env,LD_LIBRARY_PATH:LIB,FONTCONFIG_FILE:'/tmp/fontconf/fonts.conf'}});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message.slice(0,150)));
  const hits=[];
  await page.route('**/api/plugins/fanqie-bridge/fetch', async route=>{
    const body=route.request().postDataJSON(); hits.push(body.url);
    const slow = body.url.includes('slow.test');
    if (slow) await new Promise(r=>setTimeout(r,700));
    const text = body.url.includes('/s?')
      ? `<div class="result"><h3><a href="${body.url.includes('slow')?'https://slow.test':'https://fast.test'}/b/1">${body.url.includes('slow')?'慢源书':'快源书'}</a></h3></div>`
      : body.url.includes('/toc')
        ? '<ul class="list"><li><a href="https://fast.test/c/1">第1章</a></li><li><a href="https://fast.test/c/2">第2章</a></li></ul>'
        : '<h1>快源书</h1><a class="toc" href="https://fast.test/b/1/toc">目录</a>';
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,status:200,finalUrl:body.url,headers:{},text,charset:'utf-8',elapsed:1})});
  });
  await page.goto('http://127.0.0.1:8899/dev/harness-browser.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__harnessReady===true);
  await page.click('#nr-orb'); await page.waitForSelector('#nr-panel.nr-open');

  await page.evaluate(()=>{
    window.NovelReader.setOnlineSettings({searchEngine:'source',channel:'auto'});
    window.NovelReader.importSourcesJson(JSON.stringify([
      {bookSourceName:'快源',bookSourceUrl:'https://fast.test',searchUrl:'https://fast.test/s?q={{key}}',
       ruleSearch:{bookList:'class.result',name:'tag.a@text',bookUrl:'tag.a@href'},
       ruleBookInfo:{name:'tag.h1@text',tocUrl:'class.toc@href'},
       ruleToc:{chapterList:'class.list@tag.li',chapterName:'tag.a@text',chapterUrl:'tag.a@href'},
       ruleContent:{content:'#content@html'}},
      {bookSourceName:'慢源',bookSourceUrl:'https://slow.test',searchUrl:'https://slow.test/s?q={{key}}',
       ruleSearch:{bookList:'class.result',name:'tag.a@text',bookUrl:'tag.a@href'}},
    ]));
  });

  const outcome = await page.evaluate(async ()=>{
    const searchPromise = window.NovelReader.searchOnline('测试');
    await new Promise(r=>setTimeout(r,120));            // 快源大概已经回来了，慢源还在跑
    const opened = await window.NovelReader.openOnlineUrl('https://fast.test/b/1');
    const results = await searchPromise;                 // 搜索应继续到结束
    return { opened, count: results.length, titles: results.map(r=>r.title) };
  });
  check('搜索中打开书成功', Boolean(outcome.opened), JSON.stringify(outcome.opened));
  check('搜索未被中断，两个源都回来', outcome.count === 2, JSON.stringify(outcome.titles));
  check('搜索确实在书打开后仍在进行（慢源被请求）', hits.some(u=>u.includes('slow.test')), hits.length+' hits');

  const status = await page.evaluate(()=>document.querySelector('#nr-ol-status')?.textContent||'');
  check('搜索结束后状态显示打开结果', /快源书|章/.test(status) || /找到|结果/.test(status), status.slice(0,60));

  check('无页面错误', errors.length===0, errors.slice(0,2).join(' | '));
  await browser.close();
  const failed=results.filter(r=>!r.ok);
  console.log(`\n结果：${results.length-failed.length}/${results.length} 通过`);
  if(failed.length) process.exit(1);
})().catch(e=>{console.error('FAIL',e.message.slice(0,400));process.exit(1)});
