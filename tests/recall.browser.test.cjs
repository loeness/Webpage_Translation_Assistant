const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

let browser;
const core = fs.readFileSync(path.join(__dirname, '../src/content/content.core.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../assets/styles/content.css'), 'utf8');
const popupScript = fs.readFileSync(path.join(__dirname, '../src/popup/popup.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(__dirname, '../src/popup/popup.html'), 'utf8')
  .replace(/<script src="popup\.js"><\/script>/, '');
before(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
});
after(async () => { await browser?.close(); });

async function fixture(html, featureEnabled = true) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.route('http://fixture.test/**', (route) => route.fulfill({
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: `<html lang="en"><head><style>body{font:16px/1.5 Arial;margin:24px}p{max-width:700px}</style></head><body>${html}</body></html>`
  }));
  await page.goto('http://fixture.test/route-one');
  await page.addStyleTag({ content: css });
  await page.evaluate((enabled) => {
    window.chrome = { runtime: { onMessage: { addListener(fn) { window.messageHandler = fn; } } },
      storage: { local: { get(key, fn) { fn({ [key]: enabled }); } }, onChanged: { addListener() {} } } };
    window.send = (message) => new Promise((resolve) => window.messageHandler(message, {}, resolve));
  }, featureEnabled);
  await page.addScriptTag({ content: core });
  return page;
}

async function originalAfterClick(page, selector) {
  await page.keyboard.press('Escape');
  const element = page.locator(selector).first();
  await element.scrollIntoViewIfNeeded();
  await page.waitForTimeout(20);
  const point = await element.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.data.search(/\S/);
      if (index < 0) continue;
      const glyph = document.createRange();
      glyph.setStart(node, index);
      glyph.setEnd(node, index + 1);
      const rect = glyph.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
  });
  await page.mouse.click(point.x, point.y);
  return (await page.locator('#bilingual-tooltip').count())
    ? page.locator('#bilingual-tooltip').getAttribute('data-original-text') : null;
}

test('full 2,000-paragraph page: bottom is anchored before ACK, without scrolling', async () => {
  const page = await fixture(Array.from({ length: 2000 }, (_, i) =>
    `<p id="p${i}">Paragraph ${i} contains the original first sentence. Another completely different sentence follows here.</p>`).join(''));
  const result = await page.evaluate(() => window.send({ type: 'BTV_PREPROCESS_NOW' }));
  assert.equal(result.complete, true);
  assert.equal(result.sentences, 4000);
  assert.equal(await page.evaluate(() => scrollY), 0);
  assert.equal(await page.locator('#p1999 > btv-sentence').count(), 2);
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelectorAll('p > btv-sentence').forEach((span, i) => { span.textContent = i % 2 ? '第二句。' : '这是一段长度变化很大的译文，测试页面整体高度变动。'; });
  });
  assert.equal(await originalAfterClick(page, '#p1999 > btv-sentence:nth-child(2)'), 'Another completely different sentence follows here.');
  await page.close();
});

test('radically different lengths and translator wrappers do not change sentence identity', async () => {
  const page = await fixture('<p id="text">First original sentence has many many many more words than its translation. Second original sentence belongs here. Third original sentence is unique.</p>');
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    const spans = document.querySelectorAll('#text > btv-sentence');
    spans[0].innerHTML = '<font style="vertical-align: inherit">短。</font>';
    spans[1].innerHTML = `<font style="vertical-align: inherit">${'第二句译文特别长。'.repeat(30)}</font>`;
    spans[2].textContent = '第三句。';
  });
  assert.equal(await originalAfterClick(page, '#text > btv-sentence:nth-child(2) font'), 'Second original sentence belongs here.');
  assert.equal(await originalAfterClick(page, '#text > btv-sentence:nth-child(3)'), 'Third original sentence is unique.');
  await page.close();
});

test('inline formatting and links share one sentence; existing link listeners survive', async () => {
  const page = await fixture('<p id="text">This sentence has <strong>bold words</strong> and <a href="#test">a link</a> in it. A separate original sentence follows.</p>', false);
  await page.evaluate(() => {
    window.link = document.querySelector('a');
    link.addEventListener('click', (event) => { event.preventDefault(); window.linkClicked = true; });
  });
  await page.evaluate(() => window.send({ type: 'BTV_SET_ENABLED', enabled: true }));
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelectorAll('#text btv-sentence').forEach((span) => { span.textContent = '译文片段'; });
  });
  assert.equal(await originalAfterClick(page, 'strong btv-sentence'), 'This sentence has bold words and a link in it.');
  await page.locator('a').click();
  assert.equal(await page.evaluate(() => linkClicked && link === document.querySelector('a')), true);
  await page.close();
});

test('preprocess and disable/re-enable after translation preserve originals', async () => {
  const page = await fixture('<p id="text">This original sentence must be retained.</p>');
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelector('#text btv-sentence').textContent = '翻译后的句子。';
  });
  const result = await page.evaluate(() => window.send({ type: 'BTV_PREPROCESS_NOW' }));
  assert.equal(result.error, 'alreadyTranslated');
  await page.evaluate(async () => {
    await window.send({ type: 'BTV_SET_ENABLED', enabled: false });
    await window.send({ type: 'BTV_SET_ENABLED', enabled: true });
  });
  assert.equal(await originalAfterClick(page, '#text btv-sentence'), 'This original sentence must be retained.');
  await page.close();
});

test('new original content captured before translation; late translated content is not guessed', async () => {
  const page = await fixture('<p>Initial original sentence on the page.</p>');
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<p id="new">Newly loaded original sentence.</p>'); });
  await page.waitForSelector('#new btv-sentence');
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelector('#new btv-sentence').textContent = '新加载句子的译文。';
    document.body.insertAdjacentHTML('beforeend', '<p id="late">没有捕获原文的后加载译文。</p>');
  });
  assert.equal(await originalAfterClick(page, '#new btv-sentence'), 'Newly loaded original sentence.');
  assert.equal(await page.locator('#late btv-sentence').count(), 0);
  await page.keyboard.press('Escape');
  await page.locator('#late').click({ position: { x: 5, y: 10 } });
  assert.equal(await page.locator('#bilingual-tooltip').isVisible(), false);
  await page.close();
});

test('replaced translated subtree and copied anchor IDs cannot return old unrelated originals', async () => {
  const page = await fixture('<p id="text">The original belongs only to this element.</p>');
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelector('#text btv-sentence').textContent = '原有译文。';
  });
  await page.waitForTimeout(120);
  await page.evaluate(() => { document.querySelector('#text').innerHTML = '<btv-sentence data-id="1">完全不同的新内容。</btv-sentence>'; });
  await page.waitForTimeout(20);
  assert.equal((await page.evaluate(() => window.send({ type: 'BTV_PREPROCESS_NOW' }))).error, 'alreadyTranslated');
  await page.locator('#text btv-sentence').click({ position: { x: 5, y: 10 } });
  assert.equal(await page.locator('#bilingual-tooltip').count(), 0);
  await page.close();
});

test('selection aggregates exactly selected sentences and excludes the next endpoint', async () => {
  const page = await fixture('<p id="text">First original sentence. Second original sentence. Third original sentence.</p>');
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelectorAll('#text btv-sentence').forEach((span, index) => { span.textContent = `这是第${index}句译文。`; });
    const spans = document.querySelectorAll('#text btv-sentence');
    const range = document.createRange();
    range.setStart(spans[0].firstChild, 0);
    range.setEnd(spans[2].firstChild, 0);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    spans[1].dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 80 }));
  });
  assert.equal(await page.locator('#bilingual-tooltip').getAttribute('data-original-text'), 'First original sentence.\n\nSecond original sentence.');
  await page.close();
});

test('preserves short sentences, hidden content and code; repeated preprocessing is idempotent', async () => {
  const page = await fixture('<p id="short">Yes. No. Dr. Smith is here.</p><pre><code>const x = 1;</code></pre><div hidden><p>Hidden text.</p></div>');
  assert.equal(await page.locator('#short > btv-sentence').count(), 3);
  assert.equal(await page.locator('pre btv-sentence,[hidden] btv-sentence').count(), 0);
  const before = await page.locator('body').innerHTML();
  await page.evaluate(() => window.send({ type: 'BTV_PREPROCESS_NOW' }));
  assert.equal(await page.locator('body').innerHTML(), before);
  await page.close();
});

test('restore originals, capture new content, and translate again without stale sentence associations', async () => {
  const page = await fixture('<p id="text">First original sentence. Second original sentence.</p>');
  await page.evaluate(() => {
    window.saved = Array.from(document.querySelectorAll('#text btv-sentence'), (span) => span.textContent);
    document.documentElement.classList.add('translated-ltr');
    document.querySelectorAll('#text btv-sentence').forEach((span) => { span.textContent = '译文。'; });
  });
  assert.equal(await originalAfterClick(page, '#text > btv-sentence:nth-child(2)'), 'Second original sentence.');
  await page.evaluate(() => {
    document.querySelectorAll('#text btv-sentence').forEach((span, index) => { span.textContent = saved[index]; });
    document.documentElement.classList.remove('translated-ltr');
    document.body.insertAdjacentHTML('beforeend', '<p id="more">Another original after restoration.</p>');
  });
  await page.waitForSelector('#more btv-sentence');
  const result = await page.evaluate(() => window.send({ type: 'BTV_PREPROCESS_NOW' }));
  assert.equal(result.complete, true);
  assert.equal(result.sentences, 3);
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelector('#more btv-sentence').textContent = '恢复后又一次翻译。';
  });
  assert.equal(await originalAfterClick(page, '#more btv-sentence'), 'Another original after restoration.');
  await page.close();
});

test('ordinary business text changes become uncertain and never show stale originals', async () => {
  const page = await fixture('<p id="text">The download progress is zero percent.</p>');
  await page.evaluate(() => {
    document.querySelector('#text btv-sentence').textContent = 'The download progress is fifty percent.';
  });
  await page.waitForTimeout(120);
  const status = await page.evaluate(() => window.send({ type: 'BTV_GET_STATUS' }));
  assert.equal(status.unknown, true);
  assert.equal((await page.evaluate(() => window.send({ type: 'BTV_PREPROCESS_NOW' }))).error, 'uncertainSource');
  await originalAfterClick(page, '#text');
  assert.equal(await page.locator('#bilingual-tooltip').count(), 0);
  await page.close();
});

test('explicit recapture repairs uncertain original text but refuses a translated page', async () => {
  const page = await fixture('<p id="text">Initial business content.</p>');
  await page.evaluate(() => { document.querySelector('#text btv-sentence').textContent = 'Updated source content.'; });
  await page.waitForTimeout(20);
  let result = await page.evaluate(() => window.send({ type: 'BTV_RECAPTURE_SOURCE' }));
  assert.equal(result.complete, true);
  assert.equal(await page.locator('#text btv-sentence').textContent(), 'Updated source content.');
  await page.evaluate(() => document.documentElement.classList.add('translated-ltr'));
  result = await page.evaluate(() => window.send({ type: 'BTV_RECAPTURE_SOURCE' }));
  assert.equal(result.error, 'alreadyTranslated');
  await page.close();
});

test('streamed source text rebuilds the smallest block as one complete sentence', async () => {
  const page = await fixture('<p id="text">This sentence </p>');
  await page.evaluate(() => document.querySelector('#text').append('continues with dynamically loaded words.'));
  await page.waitForTimeout(20);
  assert.equal(await page.locator('#text btv-sentence').count(), 2);
  assert.equal((await page.locator('#text').textContent()), 'This sentence continues with dynamically loaded words.');
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelectorAll('#text btv-sentence').forEach((part) => { part.textContent = '动态译文片段'; });
  });
  assert.equal(await originalAfterClick(page, '#text btv-sentence:last-child'), 'This sentence continues with dynamically loaded words.');
  await page.close();
});

test('protected inline formulas remain part of sentence context and single-letter endings split normally', async () => {
  const page = await fixture('<p id="formula"><span translate="no">E = mc²</span> is the first part.</p><p id="letter">We chose option A. The second sentence stays separate.</p>');
  assert.equal(await page.locator('#letter > btv-sentence').count(), 2);
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelector('#formula btv-sentence').textContent = '是公式的第一部分。';
  });
  assert.equal(await originalAfterClick(page, '#formula btv-sentence'), 'E = mc² is the first part.');
  await page.close();
});

test('selection reports uncaptured translated text instead of silently omitting it', async () => {
  const page = await fixture('<p id="known">Captured original sentence.</p>');
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelector('#known btv-sentence').textContent = '已捕获译文。';
    document.body.insertAdjacentHTML('beforeend', '<p id="missing">没有原文记录的译文。</p>');
    const range = document.createRange();
    range.setStart(document.querySelector('#known btv-sentence').firstChild, 0);
    range.setEnd(document.querySelector('#missing').firstChild, document.querySelector('#missing').firstChild.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 100, clientY: 80 }));
  });
  const text = await page.locator('#bilingual-tooltip .btv-tip-text').textContent();
  assert.match(text, /Captured original sentence\./);
  assert.match(text, /no captured original/i);
  assert.equal(await page.locator('#bilingual-tooltip').getAttribute('data-copy-text'), 'Captured original sentence.');
  await page.close();
});

test('tooltip is scrollable, interactive, closable with Escape, and stays inside viewport', async () => {
  const page = await fixture(`<p id="text">${'Many words form one long source sentence '.repeat(150)}.</p>`);
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelector('#text btv-sentence').textContent = '译文。';
  });
  await originalAfterClick(page, '#text btv-sentence');
  const layout = await page.locator('#bilingual-tooltip').evaluate((element) => {
    const text = element.querySelector('.btv-tip-text');
    const rect = element.getBoundingClientRect();
    return {
      pointerEvents: getComputedStyle(element).pointerEvents,
      textScrollable: text.scrollHeight > text.clientHeight,
      top: rect.top,
      bottom: rect.bottom,
      viewport: innerHeight,
      actions: element.querySelectorAll('button').length
    };
  });
  assert.equal(layout.pointerEvents, 'auto');
  assert.equal(layout.textScrollable, true);
  assert.ok(layout.top >= 0 && layout.bottom <= layout.viewport);
  assert.equal(layout.actions, 2);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#bilingual-tooltip').isVisible(), false);
  await page.close();
});

test('custom anchors avoid p > span layout rules and restore removes markers', async () => {
  const page = await fixture('<style>p > span{display:block;padding-top:30px}</style><p id="text">First sentence. Second sentence.</p>', false);
  const before = await page.locator('#text').evaluate((element) => element.getBoundingClientRect().height);
  await page.evaluate(() => window.send({ type: 'BTV_SET_ENABLED', enabled: true }));
  const after = await page.locator('#text').evaluate((element) => element.getBoundingClientRect().height);
  assert.equal(after, before);
  assert.equal((await page.evaluate(() => window.send({ type: 'BTV_RESTORE_STRUCTURE' }))).restored, true);
  assert.equal(await page.locator('btv-sentence').count(), 0);
  assert.equal((await page.evaluate(() => window.send({ type: 'BTV_GET_STATUS' }))).unknown, true);
  await page.close();
});

test('SPA navigation invalidates the old epoch and captures the new original page', async () => {
  const page = await fixture('<main><p id="old">Original from route one.</p></main>');
  await page.evaluate(() => {
    history.pushState({}, '', '/route-two');
    document.querySelector('main').innerHTML = '<p id="new">Original from route two.</p>';
  });
  await page.waitForSelector('#new btv-sentence');
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelector('#new btv-sentence').textContent = '第二个路由的译文。';
  });
  assert.equal(await originalAfterClick(page, '#new btv-sentence'), 'Original from route two.');
  assert.equal(await page.locator('#old').count(), 0);
  await page.close();
});

test('SPA navigation away from a translated page cannot reuse its original records', async () => {
  const page = await fixture('<main><p id="old">Original from translated route.</p></main>');
  await page.evaluate(() => {
    document.documentElement.classList.add('translated-ltr');
    document.querySelector('#old btv-sentence').textContent = '旧路由译文。';
  });
  assert.equal(await originalAfterClick(page, '#old btv-sentence'), 'Original from translated route.');
  await page.evaluate(() => {
    history.pushState({}, '', '/translated-route-two');
    document.querySelector('main').innerHTML = '<p id="new">新路由译文。</p>';
  });
  await page.waitForTimeout(20);
  const status = await page.evaluate(() => window.send({ type: 'BTV_GET_STATUS' }));
  assert.equal(status.unknown, true);
  assert.equal(status.sentences, 0);
  assert.equal(await originalAfterClick(page, '#new'), null);
  await page.close();
});

test('popup routes prepare, recapture, restore, and toggle to their exact protocols', async () => {
  const page = await browser.newPage();
  await page.setContent(popupHtml);
  await page.evaluate(() => {
    window.sentMessages = [];
    let enabled = true;
    window.chrome = {
      i18n: { getMessage() { return ''; } },
      tabs: {
        async query() { return [{ id: 7, url: 'https://example.test/page' }]; },
        async sendMessage(_tabId, payload) {
          sentMessages.push(payload);
          if (payload.type === 'BTV_GET_STATUS') return { ok: true, enabled, translated: false, unknown: false, sentences: 2 };
          if (payload.type === 'BTV_SET_ENABLED') { enabled = payload.enabled; return { ok: true, enabled }; }
          if (payload.type === 'BTV_RESTORE_STRUCTURE') return { ok: true, restored: true };
          return { ok: true, complete: true };
        }
      },
      storage: { local: {
        async get() { return { btvFeatureEnabled: enabled }; },
        async set(value) { enabled = value.btvFeatureEnabled; }
      } },
      scripting: { async insertCSS() {}, async executeScript() {} }
    };
  });
  await page.addScriptTag({ content: popupScript });
  await page.waitForFunction(() => sentMessages.some((message) => message.type === 'BTV_GET_STATUS'));
  await page.evaluate(() => { sentMessages.length = 0; });
  await page.locator('#preprocess-btn').click();
  await page.waitForFunction(() => !document.querySelector('#preprocess-btn').disabled);
  await page.locator('details').evaluate((element) => { element.open = true; });
  await page.locator('#recapture-btn').click();
  await page.waitForFunction(() => !document.querySelector('#recapture-btn').disabled);
  await page.locator('#restore-btn').click();
  await page.waitForFunction(() => !document.querySelector('#restore-btn').disabled);
  await page.locator('#toggle-feature-btn').click();
  await page.waitForFunction(() => !document.querySelector('#toggle-feature-btn').disabled);
  assert.deepEqual(await page.evaluate(() => sentMessages.filter((message) => message.type !== 'BTV_PING')),
    [{ type: 'BTV_PREPROCESS_NOW' }, { type: 'BTV_RECAPTURE_SOURCE' },
      { type: 'BTV_RESTORE_STRUCTURE' }, { type: 'BTV_SET_ENABLED', enabled: false }]);
  await page.close();
});

test('class churn keeps existing anchors stable while newly revealed text is captured', async () => {
  const page = await fixture('<style>.gone{display:none}</style><p id="stable">Stable original sentence.</p><p id="revealed" class="gone">Newly revealed sentence.</p>');
  await page.evaluate(() => {
    window.stableAnchor = document.querySelector('#stable btv-sentence');
    for (let index = 0; index < 100; index += 1) document.querySelector('#stable').className = `state-${index}`;
    document.querySelector('#revealed').classList.remove('gone');
  });
  await page.waitForSelector('#revealed btv-sentence');
  assert.equal(await page.evaluate(() => window.stableAnchor === document.querySelector('#stable btv-sentence')), true);
  assert.equal(await page.locator('#revealed btv-sentence').textContent(), 'Newly revealed sentence.');
  await page.close();
});
