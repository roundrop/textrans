import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function context(browser: Browser, mobile = false) {
  return browser.newContext({
    locale: 'ja-JP',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    extraHTTPHeaders: { 'CF-Connecting-IP': `192.0.2.${Math.floor(Math.random() * 250) + 1}` },
  });
}
async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'QR・コードを表示' }).click();
  const code = page.getByTestId('invite-code');
  await expect(code).toHaveText(/^\d{6}$/);
  return (await code.innerText()).trim();
}
async function pair(host: Page, guest: Page) {
  const code = await start(host);
  await guest.goto('/');
  await guest.getByRole('tab', { name: 'コードを入力' }).click();
  await guest.getByRole('textbox', { name: '6桁のコード' }).fill(code);
  await guest.getByRole('button', { name: 'この端末と接続' }).click();
  await expect(host.getByTestId('sas')).toBeVisible();
  await expect(host.getByTestId('sas').locator('span')).toHaveCount(3);
  await expect(guest.getByTestId('sas')).toHaveText(await host.getByTestId('sas').innerText(), {
    useInnerText: true,
  });
  await host.getByRole('button', { name: '同じ数字です' }).click();
  await guest.getByRole('button', { name: '同じ数字です' }).click();
  await expect(host.getByText('2台がつながりました')).toBeVisible();
  await expect(guest.getByText('2台がつながりました')).toBeVisible();
  return code;
}

let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts) await c.close();
  contexts = [];
});
async function pages(browser: Browser) {
  const a = await context(browser),
    b = await context(browser, true);
  contexts.push(a, b);
  return { host: await a.newPage(), guest: await b.newPage(), a, b };
}

test('code pairing, bidirectional Unicode text, safe rendering, and consumed invite', async ({
  browser,
}) => {
  const { host, guest } = await pages(browser);
  const frames: string[] = [];
  host.on('websocket', (ws) =>
    ws.on('framesent', (event) => {
      frames.push(String(event.payload));
    }),
  );
  const code = await pair(host, guest);
  const message = '<script>alert("private")</script> 日本語 🥑\n  indented';
  await host.getByRole('textbox', { name: 'テキストを送る' }).fill(message);
  await host.getByRole('button', { name: 'テキストを送信' }).click();
  await expect(guest.locator('.received-text')).toHaveText(message);
  await expect(host.getByText('相手に届きました')).toBeVisible();
  expect(frames.join('')).not.toContain(message);
  await guest
    .getByRole('textbox', { name: 'テキストを送る' })
    .fill('https://example.com/a?q=日本語');
  await guest.getByRole('button', { name: 'テキストを送信' }).click();
  await expect(host.getByRole('link', { name: 'リンクを開く' })).toBeVisible();
  const result = await host.request.post('/api/join', {
    headers: { Origin: 'http://127.0.0.1:5173' },
    data: { code, mode: 'code' },
  });
  expect(result.status()).toBe(404);
  await host.getByRole('button', { name: '接続を終了' }).click();
  await host.getByRole('button', { name: '終了して履歴を消去' }).click();
  await expect(guest.getByRole('heading', { name: '接続が終了しました' })).toBeVisible();
  await expect(guest.locator('.received-text')).toHaveCount(0);
});

test('exactly 10 MB binary transfer requires acceptance and preserves every byte', async ({
  browser,
}) => {
  const { host, guest } = await pages(browser);
  await pair(host, guest);
  const data = randomBytes(10_000_000);
  await host.locator('input[type=file]').setInputFiles({
    name: 'boundary-10mb.bin',
    mimeType: 'application/octet-stream',
    buffer: data,
  });
  await expect(guest.getByRole('button', { name: '受け取る', exact: true })).toBeVisible();
  await expect(guest.getByRole('link', { name: 'ファイルを保存' })).toHaveCount(0);
  await guest.getByRole('button', { name: '受け取る', exact: true }).click();
  await expect(guest.getByTestId('history-entry')).toBeFocused();
  await expect(guest.getByRole('link', { name: 'ファイルを保存' })).toBeVisible({
    timeout: 40_000,
  });
  await expect(host.getByText('相手に届きました')).toBeVisible();
  const downloadEvent = guest.waitForEvent('download');
  await guest.getByRole('link', { name: 'ファイルを保存' }).click();
  const download = await downloadEvent;
  const saved = await readFile((await download.path())!);
  expect(saved.length).toBe(10_000_000);
  expect(createHash('sha256').update(saved).digest('hex')).toBe(
    createHash('sha256').update(data).digest('hex'),
  );
});

test('rejects oversized files, supports declining and empty files', async ({ browser }) => {
  const { host, guest } = await pages(browser);
  await pair(host, guest);
  await host
    .locator('input[type=file]')
    .setInputFiles({ name: 'too-big.bin', mimeType: '', buffer: Buffer.alloc(10_000_001) });
  await expect(host.getByRole('alert')).toContainText('10,000,000');
  await expect(guest.locator('.incoming-card')).toHaveCount(0);
  await host
    .locator('input[type=file]')
    .setInputFiles({ name: 'decline.txt', mimeType: 'text/plain', buffer: Buffer.from('private') });
  await guest.getByRole('button', { name: '受け取らない', exact: true }).click();
  await expect(host.getByText('中止しました')).toBeVisible();
  await host
    .locator('input[type=file]')
    .setInputFiles({ name: 'empty.bin', mimeType: '', buffer: Buffer.alloc(0) });
  await guest.getByRole('button', { name: '受け取る', exact: true }).click();
  await expect(guest.getByRole('link', { name: 'ファイルを保存' })).toBeVisible();
});

test('reconnects without changing keys or duplicating deliveries', async ({ browser }) => {
  const { host, guest } = await pages(browser);
  await host.addInitScript(() => {
    const Native = window.WebSocket;
    (window as unknown as { testSockets: WebSocket[] }).testSockets = [];
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as unknown as { testSockets: WebSocket[] }).testSockets.push(this);
      }
    };
  });
  await pair(host, guest);
  await host.getByRole('textbox', { name: 'テキストを送る' }).fill('before reconnect');
  await host.getByRole('button', { name: 'テキストを送信' }).click();
  await expect(guest.locator('.received-text')).toHaveText('before reconnect');
  await host.evaluate(() => {
    const sockets = (window as unknown as { testSockets: WebSocket[] }).testSockets;
    sockets.find((socket) => socket.url.includes('/api/rooms/'))!.close(4000, 'test-network-drop');
  });
  await expect(host.getByText('2台がつながりました')).toBeVisible({ timeout: 15_000 });
  await host.getByRole('textbox', { name: 'テキストを送る' }).fill('after reconnect');
  await host.getByRole('button', { name: 'テキストを送信' }).click();
  await expect(guest.locator('.received-text')).toHaveText(['after reconnect', 'before reconnect']);
  await expect(
    host.locator('.delivery-status').filter({ hasText: '相手に届きました' }),
  ).toHaveCount(2);
});

test('API refuses cross-origin requests, malformed input and unauthorized sockets', async ({
  request,
}) => {
  const missingOrigin = await request.post('/api/rooms', { data: {} });
  expect(missingOrigin.status()).toBe(403);
  const wrongOrigin = await request.post('/api/rooms', {
    headers: { Origin: 'https://attacker.invalid' },
    data: {},
  });
  expect(wrongOrigin.status()).toBe(403);
  const invalid = await request.post('/api/join', {
    headers: { Origin: 'http://127.0.0.1:5173' },
    data: { code: '123', mode: 'code' },
  });
  expect(invalid.status()).toBe(400);
  const large = await request.post('/api/rooms', {
    headers: { Origin: 'http://127.0.0.1:5173' },
    data: { extra: 'x'.repeat(2000) },
  });
  expect(large.status()).toBe(400);
});

test('mobile home fits, is keyboard usable, and language switching works', async ({ browser }) => {
  const c = await context(browser, true);
  contexts.push(c);
  const page = await c.newPage();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('tab', { name: '別の端末とつなぐ' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('textbox', { name: '6桁のコード' })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button', { name: 'QR・コードを表示' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.getByRole('button', { name: 'Show QR & code' })).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/home-mobile.png',
    fullPage: true,
  });
});

test('QR link authenticates automatically and keeps the fragment out of requests', async ({
  browser,
}) => {
  const { host, guest } = await pages(browser);
  await start(host);
  await host.evaluate(() => {
    navigator.clipboard.writeText = async (value) => {
      (window as unknown as { invite: string }).invite = value;
    };
  });
  await host.getByRole('button', { name: '招待リンクをコピー' }).click();
  const invite = await host.evaluate(() => (window as unknown as { invite: string }).invite);
  const key = new URLSearchParams(new URL(invite).hash.slice(1)).get('key')!;
  const requests: string[] = [];
  guest.on('request', (request) => {
    requests.push(request.url() + (request.postData() || ''));
  });
  await guest.goto(invite);
  await expect(guest.getByText('2台がつながりました')).toBeVisible();
  await expect(host.getByText('2台がつながりました')).toBeVisible();
  expect(new URL(guest.url()).hash).toBe('');
  // The initial browser navigation event can include a fragment in Playwright's
  // URL; the actual API requests must never contain the key.
  expect(requests.filter((value) => value.includes('/api/')).join('')).not.toContain(key);
  await host.getByRole('textbox', { name: 'テキストを送る' }).fill('QR handoff');
  await host.getByRole('button', { name: 'テキストを送信' }).click();
  await expect(guest.locator('.received-text')).toHaveText('QR handoff');
  await expect(host.getByText('相手に届きました')).toBeVisible();
  await host.screenshot({
    animations: 'disabled',
    path: `test-results/connected-desktop-${test.info().project.name}.png`,
    fullPage: true,
  });
  await guest.screenshot({
    animations: 'disabled',
    path: `test-results/connected-mobile-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test('resumes a file after losing a chunk connection and verifies the downloaded bytes', async ({
  browser,
}) => {
  const { host, guest } = await pages(browser);
  await host.addInitScript(() => {
    const Native = window.WebSocket;
    let chunks = 0;
    window.WebSocket = class extends Native {
      send(data: string | ArrayBuffer | Blob | ArrayBufferView<ArrayBuffer>) {
        if (data instanceof ArrayBuffer && data.byteLength > 5000 && ++chunks === 6) {
          this.close(4000, 'test-mid-file-drop');
          return;
        }
        super.send(data);
      }
    };
  });
  await pair(host, guest);
  const bytes = randomBytes(2_000_000);
  await host
    .locator('input[type=file]')
    .setInputFiles({ name: 'resume.bin', mimeType: '', buffer: bytes });
  await guest.getByRole('button', { name: '受け取る', exact: true }).click();
  await expect(guest.getByRole('link', { name: 'ファイルを保存' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(host.getByText('相手に届きました')).toBeVisible();
  const event = guest.waitForEvent('download');
  await guest.getByRole('link', { name: 'ファイルを保存' }).click();
  const download = await event;
  expect(await readFile((await download.path())!)).toEqual(bytes);
  await expect(guest.getByTestId('history-entry')).toHaveCount(1);
});

test('production serves the security policy and authorizes only room capabilities', async ({
  request,
}) => {
  const html = await request.get('/');
  expect(html.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(html.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(html.headers()['referrer-policy']).toBe('no-referrer');
  const origin = 'http://127.0.0.1:5173';
  const created = await request.post('/api/rooms', {
    headers: { Origin: origin, 'CF-Connecting-IP': '198.51.100.9' },
    data: {},
  });
  expect(created.status()).toBe(200);
  expect(created.headers()['cache-control']).toBe('no-store');
  const { roomId, code } = await created.json();
  const unauthorized = await request.get(`/api/rooms/${roomId}/socket`, {
    headers: {
      Origin: origin,
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': `textrans-v1, ${'B'.repeat(43)}`,
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
    },
  });
  expect(unauthorized.status()).toBe(401);
  const claims = await Promise.all(
    [0, 1].map(() =>
      request.post('/api/join', { headers: { Origin: origin }, data: { code, mode: 'code' } }),
    ),
  );
  expect(claims.map((response) => response.status()).sort()).toEqual([200, 404]);
});

test('maximum text with JSON escapes remains transferable', async ({ browser }) => {
  const { host, guest } = await pages(browser);
  await pair(host, guest);
  // Backslashes double in JSON; the encrypted frame limit must still admit a
  // valid 64 KiB text message.
  const message = '\\'.repeat(64 * 1024);
  await host.getByRole('textbox', { name: 'テキストを送る' }).fill(message);
  await host.getByRole('button', { name: 'テキストを送信' }).click();
  await expect(guest.locator('.received-text')).toHaveText(message);
  await expect(host.getByText('相手に届きました')).toBeVisible();
});

test('invalid invitation stays in the form and supports correction', async ({ browser }) => {
  const c = await context(browser, true);
  contexts.push(c);
  const page = await c.newPage();
  await page.route('**/api/join', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invite-unavailable' }),
    }),
  );
  await page.goto('/');
  await page.getByRole('tab', { name: 'コードを入力' }).click();
  const input = page.getByRole('textbox', { name: '6桁のコード' });
  await input.fill('１２３ ４５６');
  await expect(input).toHaveValue('123456');
  await page.getByRole('button', { name: 'この端末と接続' }).click();
  await expect(page.getByRole('alert')).toContainText('新しいコード');
  await expect(input).toHaveValue('123456');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await input.fill('654321');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await expect(page.getByRole('button', { name: 'この端末と接続' })).toBeEnabled();
});

test('ending protects a draft, supports Escape and restores focus', async ({ browser }) => {
  const { host, guest } = await pages(browser);
  await pair(host, guest);
  const editor = host.getByRole('textbox', { name: 'テキストを送る' });
  await editor.fill('Keep this unsent draft.');
  await host.getByRole('link', { name: 'Textrans', exact: true }).press('Enter');
  const dialog = host.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'この画面に戻る' })).toBeFocused();
  await host.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(editor).toHaveValue('Keep this unsent draft.');
  await expect(host.getByRole('link', { name: 'Textrans', exact: true })).toBeFocused();
  await host.getByRole('button', { name: '接続を終了' }).click();
  await host.getByRole('button', { name: 'この画面に戻る' }).click();
  await expect(editor).toHaveValue('Keep this unsent draft.');
  await expect(guest.getByText('2台がつながりました')).toBeVisible();
  await host.getByRole('button', { name: '接続を終了' }).click();
  await host.screenshot({
    animations: 'disabled',
    path: 'test-results/end-confirmation-' + test.info().project.name + '.png',
  });
  await host.getByRole('button', { name: '終了して履歴を消去' }).click();
  await expect(host.getByRole('button', { name: 'QR・コードを表示' })).toBeVisible();
  await expect(guest.getByRole('heading', { name: '接続が終了しました' })).toBeVisible();
});

test('copy feedback is local to its action and incoming files appear above the mobile composer', async ({
  browser,
}) => {
  const { host, guest } = await pages(browser);
  await pair(host, guest);
  await guest.evaluate(() => {
    navigator.clipboard.writeText = async (value) => {
      (window as unknown as { copiedText: string }).copiedText = value;
    };
  });
  await host
    .getByRole('textbox', { name: 'テキストを送る' })
    .fill('週末の待ち合わせは、10時に駅前で。');
  await host.getByRole('button', { name: 'テキストを送信' }).click();
  await guest.getByRole('button', { name: 'コピー', exact: true }).click();
  await expect(guest.getByRole('button', { name: 'コピーしました', exact: true })).toBeVisible();
  expect(await guest.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toBe(
    '週末の待ち合わせは、10時に駅前で。',
  );
  await guest.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await host.locator('input[type=file]').setInputFiles({
    name: '旅のしおり・週末のお出かけプラン.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('Synthetic UI test file'),
  });
  const accept = guest.getByRole('button', { name: '受け取る', exact: true });
  await expect(accept).toBeVisible();
  const incoming = await guest.locator('.incoming-card').boundingBox();
  const compose = await guest.locator('.compose-card').boundingBox();
  expect(incoming!.y + incoming!.height).toBeLessThan(compose!.y);
  expect((await accept.boundingBox())!.y).toBeLessThan(500);
  await guest.screenshot({
    animations: 'disabled',
    path: 'test-results/incoming-mobile-' + test.info().project.name + '.png',
    fullPage: true,
  });
  await guest.getByRole('button', { name: '受け取らない', exact: true }).click();
});

test('visual states fit narrow screens and large text with reduced motion', async ({ browser }) => {
  const c = await context(browser);
  contexts.push(c);
  const page = await c.newPage();
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/home-light-desktop-' + test.info().project.name + '.png',
    fullPage: true,
  });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('tab', { name: 'コードを入力' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/join-' + colorScheme + '-mobile-' + test.info().project.name + '.png',
      fullPage: true,
    });
    await page.getByRole('tab', { name: '別の端末とつなぐ' }).click();
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'QR・コードを表示' })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const code = await start(page);
  const copyCode = page.getByRole('button', { name: '6桁のコードをコピー' });
  await expect(copyCode).toBeVisible();
  await expect(page.getByTestId('invite-code')).toHaveText(code);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/waiting-mobile-' + test.info().project.name + '.png',
    fullPage: true,
  });
});

test('animated pairing and dialog interactions respect the production CSP', async ({ browser }) => {
  const { host, guest, a, b } = await pages(browser);
  for (const ctx of [a, b]) {
    await ctx.addInitScript(() => {
      (window as unknown as { violations: string[] }).violations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        (window as unknown as { violations: string[] }).violations.push(event.violatedDirective);
      });
    });
  }
  // Keep this test separate from screenshots: Playwright's older WebKit screenshot
  // preparation injects a "body {}" style element, which our CSP correctly blocks.
  await pair(host, guest);
  await host.getByRole('textbox', { name: 'テキストを送る' }).fill('CSP-safe transitions');
  await host.getByRole('button', { name: 'テキストを送信' }).click();
  await expect(guest.locator('.received-text')).toHaveText('CSP-safe transitions');
  await host.getByRole('button', { name: '接続を終了' }).click();
  await expect(host.getByRole('dialog')).toBeVisible();
  await host.keyboard.press('Escape');
  await expect(host.getByRole('dialog')).not.toBeVisible();
  for (const page of [host, guest]) {
    expect(
      await page.evaluate(() => (window as unknown as { violations: string[] }).violations),
    ).toEqual([]);
  }
});
