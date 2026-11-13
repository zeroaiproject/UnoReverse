import puppeteer from '/opt/latvi/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import fs from 'fs';

const out = [];
const log = (obj) => { out.push(obj); try { process.stdout.write(JSON.stringify(obj).slice(0,4000) + '\n'); } catch(e){} };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
    headless: 'new',
    userDataDir: `/tmp/gemini-chrome-${Date.now()}`,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--window-size=1280,900','--lang=en-US,en',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  const interesting = (url) => url.includes('gemini.google.com') || url.includes('BardChatUi') || url.includes('batchexecute') || url.includes('/_/') || url.includes('StreamGenerate') || url.includes('assistant') || url.includes('rpc');

  page.on('request', req => {
    const url = req.url();
    if (interesting(url)) {
      const pd = req.postData();
      log({ type: 'request', method: req.method(), url, headers: req.headers(), postData: pd ? (pd.length > 5000 ? pd.slice(0,5000)+'...[truncated]' : pd) : undefined });
    }
  });
  page.on('response', async res => {
    const url = res.url();
    if (interesting(url) && (url.includes('batchexecute') || url.includes('StreamGenerate') || url.includes('/_/BardChatUi/data') || url.includes('log') || url.includes('rpc'))) {
      let body = null;
      try {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('text') || ct.includes('protobuf') || ct.includes('x-www-form-urlencoded')) {
          body = await res.text();
          if (body && body.length > 20000) body = body.slice(0,20000) + '...[truncated]';
        }
      } catch (e) { body = `<err:${e.message}>`; }
      log({ type: 'response', url, status: res.status(), headers: res.headers(), body });
    }
  });

  try {
    log({ type: 'nav', msg: 'goto' });
    await page.goto('https://gemini.google.com/', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));
    log({ type: 'title', title: await page.title(), url: page.url() });
    const content = await page.content();
    fs.writeFileSync('/root/reversed/gemini/home.html', content.slice(0, 800000));
    await page.screenshot({ path: '/root/reversed/gemini/home.png', fullPage: false }).catch(()=>{});

    // collect script URLs and app data
    const scripts = await page.evaluate(() => Array.from(document.scripts).map(s => s.src).filter(Boolean));
    const links = await page.evaluate(() => Array.from(document.querySelectorAll('link')).map(l => l.href).filter(Boolean));
    fs.writeFileSync('/root/reversed/gemini/page_assets.json', JSON.stringify({scripts, links}, null, 2));

    // try to find textarea / prompt area (may require sign-in)
    const sels = ['rich-textarea', 'textarea', '[contenteditable="true"]', 'div[aria-label*="prompt"]', '.ql-editor', 'input'];
    for (const sel of sels) {
      const els = await page.$$(sel);
      if (els.length) log({ type: 'found_elements', selector: sel, count: els.length });
    }
  } catch (e) {
    log({ type: 'error', message: e.message, stack: String(e.stack).slice(0,1500) });
  }

  fs.writeFileSync('/root/reversed/gemini/network_capture.jsonl', out.map(x=>JSON.stringify(x)).join('\n') + '\n');
  await browser.close();
})();
