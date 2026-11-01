const { chromium } = require('playwright');
const EXE='/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB='/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const results=[]; const check=(n,ok,x='')=>{results.push({n,ok});console.log(ok?'✓':'✗',n,x)};
const JUNK=/<i\s|fa-solid|fa-regular|class="/;
(async()=>{
  const browser=await chromium.launch({executablePath:EXE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader'],env:{...process.env,LD_LIBRARY_PATH:LIB,FONTCONFIG_FILE:'/tmp/fontconf/fonts.conf'}});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message.slice(0,150)));
  await page.goto('http://127.0.0.1:8899/dev/harness-browser.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__harnessReady===true);
  await page.click('#nr-orb'); await page.waitForSelector('#nr-panel.nr-open');

  // 书源管理：每行末尾不能有 HTML/CSS 代码文本
  await page.click('#nr-panel .nr-tab[data-tab="online"]');
  await page.click('#nr-ol-source-manage');
  await page.waitForSelector('#nr-source-list');
  await page.fill('#nr-source-json', JSON.stringify([
    {bookSourceName:'甲源',bookSourceUrl:'https://a.test',searchUrl:'https://a.test/s?q={{key}}',ruleSearch:{bookList:'class.r',name:'a@text',bookUrl:'a@href'}},
    {bookSourceName:'乙源',bookSourceUrl:'https://b.test',searchUrl:'https://b.test/s?q={{key}}',ruleSearch:{bookList:'class.r',name:'a@text',bookUrl:'a@href'}},
  ]));
  await page.click('#nr-source-import');
  await page.waitForTimeout(400);
  const rows = await page.$$eval('#nr-source-list .nr-source-item', els=>els.map(el=>el.textContent));
  check('书源行没有裸露的 HTML/CSS 代码', rows.length>=2 && rows.every(t=>!JUNK.test(t)), rows.map(t=>t.replace(/\s+/g,' ').slice(0,60)).join(' | '));
  const icons = await page.$$eval('#nr-source-list .nr-source-item i', els=>els.length);
  check('书源行的图标是真图标元素', icons>=2, 'icons='+icons);

  // 分组管理行
  await page.click('#nr-source-close');
  await page.waitForTimeout(300);
  await page.click('#nr-panel .nr-tab[data-tab="library"]');
  await page.waitForTimeout(200);
  await page.click('#nr-shelf-groups');
  await page.fill('#nr-shelf-group-new-name','测试组');
  await page.click('#nr-shelf-group-create');
  await page.waitForTimeout(300);
  const groupText = await page.$$eval('.nr-shelf-group-row', els=>els.map(el=>el.textContent));
  check('分组行没有裸露的 HTML/CSS 代码', groupText.length>=1 && groupText.every(t=>!JUNK.test(t)), groupText.join(' | ').slice(0,80));
  await page.click('#nr-shelf-group-close');

  // 书签列表行
  await page.evaluate(async()=>{await window.NovelReader.importText('书签书','第1章 a\n正文。\n第2章 b\n正文二。');});
  await page.waitForTimeout(400);
  await page.click('#nr-panel .nr-tab[data-tab="library"]');
  await page.locator('.nr-book-card').first().click();
  await page.waitForSelector('#nr-article:not([hidden])');
  await page.click('#nr-bookmark-btn');
  await page.click('#nr-bookmark-add');
  await page.waitForTimeout(300);
  const bmText = await page.$$eval('.nr-bookmark-item', els=>els.map(el=>el.textContent));
  check('书签行没有裸露的 HTML/CSS 代码', bmText.length>=1 && bmText.every(t=>!JUNK.test(t)), bmText.join(' | ').slice(0,80));
  await page.click('#nr-bookmark-close');

  check('无页面错误', errors.length===0, errors.slice(0,2).join(' | '));
  await browser.close();
  const failed=results.filter(r=>!r.ok);
  console.log(`\n结果：${results.length-failed.length}/${results.length} 通过`);
  if(failed.length) process.exit(1);
})().catch(e=>{console.error('FAIL',e.message.slice(0,400));process.exit(1)});
