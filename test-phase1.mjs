// Phase 1 verification: drives the real UI in Chromium with a fake microphone
// and stubbed API endpoints. Verifies crash-proof capture (IndexedDB), the
// heartbeat/meter, and the crash -> recover flow. Temporary; safe to delete.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(browser, { chunkFails = false } = {}) {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();

  // Small segment so rotation (and thus chunk persistence) happens fast.
  await page.route('**/api/config', (r) =>
    r.fulfill({ json: { segmentMinutes: 0.02, segmentMs: 1200 } }));
  await page.route('**/api/session/start', (r) =>
    r.fulfill({ json: { sessionId: 'testsessionaaaa1111' } }));
  await page.route('**/api/session/resume', (r) =>
    r.fulfill({ json: { sessionId: 'testsessionaaaa1111', existed: false } }));
  await page.route('**/api/transcribe-chunk', async (r) => {
    if (chunkFails) return r.fulfill({ status: 500, json: { error: 'stub failure' } });
    return r.fulfill({ json: { ok: true, text: 'stub transcript' } });
  });
  await page.route('**/api/finalize', (r) =>
    r.fulfill({ json: { rawTranscript: 'stub raw transcript', markdown: '# Stub summary' } }));

  page.on('console', (m) => { if (m.type() === 'error') console.log('  [browser error]', m.text()); });
  return { context, page };
}

const idbCount = (page) => page.evaluate(() => idbGetAll().then((a) => a.length));

async function run() {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });

  // ---------- Test 1: happy path ----------
  {
    const { context, page } = await newPage(browser);
    await page.goto(BASE);
    await page.click('#recordBtn');
    // Wait for capture to actually start (fake getUserMedia init varies in headless).
    await page.waitForSelector('#stopBtn:not(.hidden)', { timeout: 8000 });
    ok('stop button shown', await page.isVisible('#stopBtn'));

    const meterVisible = await page.isVisible('#levelMeter');
    ok('meter visible while recording', meterVisible);
    const recText = await page.textContent('#recStatus');
    ok('heartbeat timer shown (mm:ss)', /\d\d:\d\d/.test(recText));

    // Let a couple of segments rotate + persist + (stub) transcribe.
    await sleep(2600);
    await page.click('#stopBtn');
    // Stop no longer auto-finalizes: the user must click Transcribe & Structure.
    await page.waitForSelector('#finishBtn:not(.hidden)', { timeout: 8000 });
    ok('review card hidden until Transcribe clicked', !(await page.isVisible('#review-card')));
    await page.click('#finishBtn');
    await page.waitForSelector('#review-card:not(.hidden)', { timeout: 8000 });
    ok('review card appears after Transcribe clicked', await page.isVisible('#review-card'));
    ok('markdown populated from finalize', (await page.inputValue('#markdownOutput')).includes('Stub summary'));
    ok('meter hidden after stop', !(await page.isVisible('#levelMeter')));

    await sleep(300);
    ok('IndexedDB empty after successful finalize', (await idbCount(page)) === 0);
    await context.close();
  }

  // ---------- Test 2: crash -> recovery ----------
  {
    // Recording where every chunk upload fails => audio stays in IndexedDB.
    const { context, page } = await newPage(browser, { chunkFails: true });
    await page.goto(BASE);
    await page.click('#recordBtn');
    await sleep(3000); // let 2+ segments rotate & persist while uploads fail

    const persisted = await idbCount(page);
    ok('chunks persisted to IndexedDB during recording', persisted > 0);

    // Simulate a crash: kill the page without pressing Stop.
    await page.close();

    // Reopen in the SAME storage context so IndexedDB survives (like a real reload).
    const page2 = await context.newPage();
    await page2.route('**/api/config', (r) => r.fulfill({ json: { segmentMinutes: 0.02, segmentMs: 1200 } }));
    await page2.route('**/api/session/resume', (r) => r.fulfill({ json: { sessionId: 'testsessionaaaa1111', existed: false } }));
    await page2.route('**/api/transcribe-chunk', (r) => r.fulfill({ json: { ok: true, text: 'stub transcript' } }));
    await page2.route('**/api/finalize', (r) => r.fulfill({ json: { rawTranscript: 'stub raw transcript', markdown: '# Recovered summary' } }));
    page2.on('console', (m) => { if (m.type() === 'error') console.log('  [browser error]', m.text()); });

    await page2.goto(BASE);
    await page2.waitForSelector('#recovery-card:not(.hidden)', { timeout: 8000 });
    ok('recovery card shown on reopen', await page2.isVisible('#recovery-card'));
    const info = await page2.textContent('#recoveryInfo');
    ok('recovery info reports saved segments', /segment\(s\)/.test(info));

    // Recover: uploads now succeed, finalize returns.
    await page2.click('#recoverBtn');
    await page2.waitForSelector('#review-card:not(.hidden)', { timeout: 10000 });
    ok('recovery produces a finalized record', (await page2.inputValue('#markdownOutput')).includes('Recovered summary'));
    await sleep(300);
    ok('IndexedDB cleared after successful recovery', (await idbCount(page2)) === 0);
    ok('recovery card hidden after recovery', !(await page2.isVisible('#recovery-card')));
    await context.close();
  }

  // ---------- Test 3: discard ----------
  {
    const { context, page } = await newPage(browser, { chunkFails: true });
    await page.goto(BASE);
    await page.click('#recordBtn');
    await sleep(2600);
    await page.close();

    const page2 = await context.newPage();
    await page2.route('**/api/config', (r) => r.fulfill({ json: { segmentMinutes: 0.02, segmentMs: 1200 } }));
    await page2.goto(BASE);
    await page2.waitForSelector('#recovery-card:not(.hidden)', { timeout: 8000 });
    await page2.click('#discardBtn');
    await page2.waitForSelector('#recovery-card', { state: 'hidden', timeout: 5000 });
    ok('discard clears IndexedDB', (await idbCount(page2)) === 0);
    await context.close();
  }

  await browser.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
