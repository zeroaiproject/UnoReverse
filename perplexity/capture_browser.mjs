import puppeteer from '/opt/latvi/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import fs from 'fs';

const out = [];
const log = (obj) => { out.push(obj); process.stdout.write(JSON.stringify(obj) + '\n'); };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
    headless: 'new',
    userDataDir: `/tmp/pplx-chrome-${Date.now()}`,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900',
      '--lang=en-US,en',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });

  page.on('request', req => {
    const url = req.url();
    if (url.includes('perplexity') || url.includes('socket.io') || url.includes('/rest/') || url.includes('/api/')) {
      const entry = { type: 'request', method: req.method(), url, headers: req.headers(), postData: req.postData() };
      if (url.includes('perplexity_ask') || url.includes('sse') || url.includes('socket.io') || url.includes('/api/') || url.includes('/rest/')) {
        log(entry);
      }
    }
  });
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('perplexity_ask') || url.includes('/rest/') || url.includes('/api/auth') || url.includes('socket.io')) {
      let body = null;
      try {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('text') || ct.includes('event-stream')) {
          body = await res.text();
          if (body && body.length > 20000) body = body.slice(0, 20000) + '...[truncated]';
        }
      } catch (e) { body = `<err:${e.message}>`; }
      log({ type: 'response', url, status: res.status(), headers: res.headers(), body });
    }
  });

  try {
    log({ type: 'nav', msg: 'goto' });
    await page.goto('https://www.perplexity.ai/', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));
    log({ type: 'title', title: await page.title(), url: page.url() });
    const content = await page.content();
    fs.writeFileSync('/root/reversed/perplexity/home_snapshot.html', content.slice(0, 500000));

    // try to find search input and submit a query to trigger API
    const selectors = ['textarea', 'input[type="text"]', '[contenteditable="true"]', 'textarea[placeholder]'];
    let typed = false;
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        log({ type: 'found_input', selector: sel });
        await el.click({ delay: 50 }).catch(()=>{});
        await page.keyboard.type('what is 2+2', { delay: 30 }).catch(()=>{});
        await page.keyboard.press('Enter').catch(()=>{});
        typed = true;
        break;
      }
    }
    if (!typed) log({ type: 'no_input' });
    await new Promise(r => setTimeout(r, 15000));
    log({ type: 'final_url', url: page.url(), title: await page.title() });
  } catch (e) {
    log({ type: 'error', message: e.message, stack: e.stack });
  }

  fs.writeFileSync('/root/reversed/perplexity/network_capture.jsonl', out.map(x=>JSON.stringify(x)).join('\n') + '\n');
  await browser.close();
})();
