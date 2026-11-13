process.env.NODE_PATH = '/opt/latvi/node_modules';
import { createRequire } from 'module';
const require = createRequire('/opt/latvi/node_modules/');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
import fs from 'fs';

const out = [];
const log = (obj) => { out.push(obj); try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch(e){} };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
    headless: false,
    userDataDir: `/tmp/pplx-stealth-${Date.now()}`,
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
  page.on('request', req => {
    const url = req.url();
    if (url.includes('perplexity_ask') || url.includes('/rest/') || url.includes('/api/') || url.includes('socket.io')) {
      log({ type: 'request', method: req.method(), url, headers: req.headers(), postData: req.postData() });
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
          if (body && body.length > 30000) body = body.slice(0, 30000) + '...[truncated]';
        }
      } catch (e) { body = `<err:${e.message}>`; }
      log({ type: 'response', url, status: res.status(), headers: res.headers(), body });
    }
  });

  try {
    log({ type: 'nav', msg: 'goto' });
    await page.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    for (let i=0;i<30;i++) {
      await new Promise(r=>setTimeout(r,2000));
      const title = await page.title();
      const url = page.url();
      if (i%5===0) log({type:'poll', i, title, url});
      if (!/just a moment/i.test(title) && !/challenge/i.test(title)) break;
    }
    await new Promise(r=>setTimeout(r,3000));
    const title = await page.title();
    log({ type: 'title', title, url: page.url() });
    fs.writeFileSync('/root/reversed/perplexity/home_stealth.html', (await page.content()).slice(0,500000));
    await page.screenshot({ path: '/root/reversed/perplexity/home_stealth.png', fullPage: false }).catch(()=>{});

    // trigger query
    const selectors = ['textarea', 'textarea[placeholder*="Ask"]', '[role="textbox"]', 'input[type="text"]'];
    let typed = false;
    for (const sel of selectors) {
      const els = await page.$$(sel);
      for (const el of els) {
        const box = await el.boundingBox();
        if (box && box.width > 50 && box.height > 10) {
          log({ type: 'found_input', selector: sel, box });
          await el.click({ delay: 80 }).catch(()=>{});
          await page.keyboard.type('what is 2+2? answer briefly', { delay: 40 }).catch(()=>{});
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
    fs.writeFileSync('/root/reversed/perplexity/after_query.html', (await page.content()).slice(0,500000));
  } catch (e) {
    log({ type: 'error', message: e.message, stack: String(e.stack).slice(0,2000) });
  }

  fs.writeFileSync('/root/reversed/perplexity/network_capture_stealth.jsonl', out.map(x=>JSON.stringify(x)).join('\n') + '\n');
  await browser.close();
})();
