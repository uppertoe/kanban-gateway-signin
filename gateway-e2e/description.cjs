// Gateway sign-in (local modification): end-to-end browser check. A person
// created by gateway sign-in has no username, and upstream 2.3.0 crashed the
// description editor to a blank page on any board with such a member. This
// signs in through the gateway headers, opens a card on that board, edits its
// description and saves it. With an idle time, it then leaves the page alone
// for that long and checks that PLANKA's automatic sign-out, which is off in
// gateway mode, neither warned nor signed out. Usage (inside the Playwright
// image, sharing the planka container's network):
//   node description.cjs <card id> <text> [idle seconds]
const { chromium } = require('playwright-core');

const [cardId, text, idleSeconds] = process.argv.slice(2);
const base = 'http://localhost:1337';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    extraHTTPHeaders: {
      'x-gateway-secret': process.env.GATEWAY_SECRET,
      'remote-email': process.env.GATEWAY_EMAIL,
      'remote-groups': process.env.GATEWAY_GROUPS,
    },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  let result = 'saved';
  try {
    await page.goto(`${base}/cards/${cardId}`);
    await page.click('[class*="descriptionButton"]', { timeout: 30000 });
    await page.waitForSelector('[class*="controls"] button.positive', { timeout: 10000 });
    await page.keyboard.type(text);
    await page.click('[class*="controls"] button.positive');
    await page.waitForSelector('[class*="controls"] button.positive', { state: 'detached', timeout: 10000 });
    // The save travels over the socket; give it a moment to reach the server.
    await page.waitForTimeout(1500);

    if (idleSeconds) {
      const before = page.url();
      await page.waitForTimeout(Number(idleSeconds) * 1000);
      // The sign-out warning is the only small modal; the card is a large one.
      if (page.url() !== before) {
        result = `signed out while idle: now at ${page.url()}`;
      } else if (await page.locator('.ui.tiny.modal').count()) {
        result = 'automatic sign-out warning shown while idle';
      }
    }
  } catch (error) {
    result = `failed: ${error.message.split('\n')[0]}`;
  }
  if (errors.length > 0) {
    result = `page error: ${errors[0]}`;
  }
  console.log(result);
  await browser.close();
})();
