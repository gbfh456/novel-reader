/**
 * 浏览器回归脚本（需要在扩展目录起静态服务：python3 -m http.server 8899，
 * 并用带 CJK 字体的 Chromium 运行；详见 PLAN-Legado-Max.md 的联调记录）。
 */
const { chromium } = require('playwright');
const EXE='/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB='/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const results=[]; const check=(n,ok,x='')=>{results.push({n,ok});console.log(ok?'✓':'✗',n,x)};
(async()=>{
  const browser=await chromium.launch({executablePath:EXE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader'],env:{...process.env,LD_LIBRARY_PATH:LIB,FONTCONFIG_FILE:'/tmp/fontconf/fonts.conf'}});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message.slice(0,150)));
  await page.goto('http://127.0.0.1:8899/dev/harness-browser.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__harnessReady===true);
  await page.click('#nr-orb');
  // 造一本多页的书：每章很长，保证分多页
  const longText = Array.from({length: 400}, (_, i) => `第${i+1}段内容，这里写长一点凑字数，让每一页都有足够的正文文本。`).join('\n');
  await page.evaluate(async (txt)=>{ await window.NovelReader.importText('翻页测试', `第1章 甲\n${txt}\n第2章 乙\n${txt}`); }, longText);
  await page.waitForTimeout(500);
  await page.click('#nr-panel .nr-tab[data-tab="library"]');
  await page.locator('.nr-book-card').first().click();
  await page.waitForSelector('#nr-article:not([hidden])');
  const pages = await page.locator('#nr-page-info').textContent();
  check('正文分多页', /\d+\s*\/\s*[2-9]/.test(pages) || /\/ [2-9]/.test(pages), pages);

  for (const mode of ['slide','cover','flip','fade','none']) {
    await page.click('#nr-reader-settings-btn');
    await page.selectOption('#nr-reader-page-turn', mode);
    await page.waitForTimeout(150);
    await page.click('#nr-reader-settings-btn');
    const beforeIdx = await page.evaluate(()=>document.querySelector('#nr-page-info').textContent);
    const ghostSeen = await page.evaluate(async (m)=>{
      const btn=document.querySelector('#nr-page-next');
      btn.click();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const ghosts=document.querySelectorAll('.nr-page-ghost').length;
      const anims=document.querySelectorAll('.nr-page-ghost').length ? document.getAnimations().length : document.getAnimations().length;
      return {ghosts, anims};
    }, mode);
    await page.waitForTimeout(700);
    const afterIdx = await page.evaluate(()=>document.querySelector('#nr-page-info').textContent);
    const leftover = await page.locator('.nr-page-ghost').count();
    const moved = beforeIdx !== afterIdx;
    const expectGhost = mode==='slide'||mode==='cover'||mode==='flip';
    check(`${mode}：翻页生效${expectGhost?'（有旧页动画层）':''}`,
      moved && leftover===0 && (!expectGhost || ghostSeen.ghosts>0),
      `ghost=${ghostSeen.ghosts} anims=${ghostSeen.anims} leftover=${leftover} ${beforeIdx}→${afterIdx}`);
    // 退回第一页以便下一轮
    await page.evaluate(()=>{ const b=document.querySelector('#nr-page-prev'); if(b && !b.disabled) b.click(); });
    await page.waitForTimeout(400);
  }
  check('无页面错误', errors.length===0, errors.slice(0,2).join(' | '));
  await browser.close();
  const failed=results.filter(r=>!r.ok);
  console.log(`\n结果：${results.length-failed.length}/${results.length} 通过`);
  if(failed.length) process.exit(1);
})().catch(e=>{console.error('FAIL',e.message.slice(0,400));process.exit(1)});
