import puppeteer from '/opt/latvi/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import fs from 'fs';

const out = [];
const log = (obj) => { out.push(obj); try { process.stdout.write(JSON.stringify(obj).slice(0,4000) + '\n'); } catch(e){} };

const interesting = (url) => /chatgpt\.com|chat\.openai\.com|backend-api|backend-anon|\/api\/|conversation|sentinel|chat-requirements|f\.conversation|stream/i.test(url);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
    headless: 'new',
    userDataDir: `/tmp/chatgpt-convo-${Date.now()}`,
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
      log({ type: 'request', method: req.method(), url, headers: req.headers(), postData: pd ? (pd.length > 12000 ? pd.slice(0,12000)+'...[truncated]' : pd) : undefined });
    }
  });
  page.on('response', async res => {
    const url = res.url();
    if (interesting(url)) {
      let body = null;
      try {
        const ct = res.headers()['content-type'] || '';
        if (/json|text|event-stream|javascript/.test(ct) || /conversation|sentinel|prepare|backend|chat-requirements|beacons|account-picker/.test(url)) {
          body = await res.text();
          if (body && body.length > 60000) body = body.slice(0,60000) + '...[truncated]';
        }
      } catch (e) { body = `<err:${e.message}>`; }
      log({ type: 'response', url, status: res.status(), headers: res.headers(), body });
    }
  });

  try {
    log({ type: 'nav', msg: 'goto' });
    await page.goto('https://chatgpt.com/', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 8000));
    log({ type: 'title', title: await page.title(), url: page.url() });

    // find composer
    const inputSel = '#prompt-textarea, textarea[data-id="root"], div#prompt-textarea[contenteditable="true"], [contenteditable="true"][data-placeholder], textarea';
    let input = await page.$(inputSel);
    if (!input) {
      // try broader
      const all = await page.$$('[contenteditable="true"], textarea');
      for (const el of all) {
        const box = await el.boundingBox().catch(()=>null);
        if (box && box.width > 100 && box.height > 20) { input = el; break; }
      }
    }
    if (!input) {
      log({ type: 'no_input' });
    } else {
      log({ type: 'found_input' });
      await input.click({ delay: 100 }).catch(()=>{});
      await new Promise(r=>setTimeout(r,500));
      await page.keyboard.type('Reply with exactly: PONG', { delay: 40 }).catch(()=>{});
      await new Promise(r=>setTimeout(r,800));
      // try send button
      const btn = await page.$('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="send"], form button[type="submit"]');
      if (btn) {
        log({ type: 'click_send' });
        await btn.click({ delay: 80 }).catch(()=>{});
      } else {
        log({ type: 'press_enter' });
        await page.keyboard.press('Enter').catch(()=>{});
      }
      // wait for response/stream
      await new Promise(r => setTimeout(r, 45000));
    }

    log({ type: 'final', url: page.url(), title: await page.title() });
    fs.writeFileSync('/root/reversed/AI/ChatGPT/convo_after.html', (await page.content()).slice(0, 800000));
    await page.screenshot({ path: '/root/reversed/AI/ChatGPT/convo_after.png', fullPage: false }).catch(()=>{});
  } catch (e) {
    log({ type: 'error', message: e.message, stack: String(e.stack).slice(0,2000) });
  }

  fs.writeFileSync('/root/reversed/AI/ChatGPT/network_capture_convo.jsonl', out.map(x=>JSON.stringify(x)).join('\n') + '\n');
  await browser.close();
})();
