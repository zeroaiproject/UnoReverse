import puppeteer from '/opt/latvi/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import fs from 'fs';

const out = [];
const log = (obj) => { out.push(obj); try { process.stdout.write(JSON.stringify(obj).slice(0,4000) + '\n'); } catch(e){} };

const interesting = (url) => /chatgpt\.com|chat\.openai\.com|backend-api|backend-anon|\/api\/|conversation|sentinel|auth0|oai-did/i.test(url);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
    headless: 'new',
    userDataDir: `/tmp/chatgpt-chrome-${Date.now()}`,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--window-size=1280,900','--lang=en-US,en',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  page.on('request', req => {
    const url = req.url();
    if (interesting(url)) {
      const pd = req.postData();
      log({ type: 'request', method: req.method(), url, headers: req.headers(), postData: pd ? (pd.length > 8000 ? pd.slice(0,8000)+'...[truncated]' : pd) : undefined });
    }
  });
  page.on('response', async res => {
    const url = res.url();
    if (interesting(url)) {
      let body = null;
      try {
        const ct = res.headers()['content-type'] || '';
        if (/json|text|event-stream|javascript/.test(ct)) {
          body = await res.text();
          if (body && body.length > 30000) body = body.slice(0,30000) + '...[truncated]';
        }
      } catch (e) { body = `<err:${e.message}>`; }
      log({ type: 'response', url, status: res.status(), headers: res.headers(), body });
    }
  });

  try {
    log({ type: 'nav', msg: 'goto' });
    await page.goto('https://chatgpt.com/', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 6000));
    log({ type: 'title', title: await page.title(), url: page.url() });
    fs.writeFileSync('/root/reversed/AI/ChatGPT/home.html', (await page.content()).slice(0, 800000));
    await page.screenshot({ path: '/root/reversed/AI/ChatGPT/home.png', fullPage: false }).catch(()=>{});

    const scripts = await page.evaluate(() => Array.from(document.scripts).map(s => s.src).filter(Boolean));
    fs.writeFileSync('/root/reversed/AI/ChatGPT/page_assets.json', JSON.stringify({scripts}, null, 2));

    // try to trigger anon conversation if prompt box exists
    const sels = ['#prompt-textarea', 'textarea', '[contenteditable="true"]', 'textarea[data-id]', 'div[contenteditable="true"]'];
    let typed = false;
    for (const sel of sels) {
      const els = await page.$$(sel);
      for (const el of els) {
        const box = await el.boundingBox().catch(()=>null);
        if (box && box.width > 50 && box.height > 10) {
          log({ type: 'found_input', selector: sel, box });
          await el.click({ delay: 80 }).catch(()=>{});
          await page.keyboard.type('Say "hi" in one word.', { delay: 35 }).catch(()=>{});
          await page.keyboard.press('Enter').catch(()=>{});
          typed = true;
          break;
        }
      }
      if (typed) break;
    }
    if (!typed) log({ type: 'no_input' });
    await new Promise(r => setTimeout(r, 25000));
    log({ type: 'final', url: page.url(), title: await page.title() });
    fs.writeFileSync('/root/reversed/AI/ChatGPT/after.html', (await page.content()).slice(0, 800000));
  } catch (e) {
    log({ type: 'error', message: e.message, stack: String(e.stack).slice(0,2000) });
  }

  fs.writeFileSync('/root/reversed/AI/ChatGPT/network_capture.jsonl', out.map(x=>JSON.stringify(x)).join('\n') + '\n');
  await browser.close();
})();
