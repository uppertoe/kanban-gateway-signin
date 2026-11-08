// Gateway sign-in (local modification): end-to-end browser check that signing
// out of PLANKA hands over to the gateway's sign-out page, since signing out
// of PLANKA alone would sign the person straight back in. Usage (inside the
// Playwright image, sharing the planka container's network):
//   node logout.cjs <expected sign-out URL>
const { chromium } = require('playwright-core');

const [logoutUrl] = process.argv.slice(2);
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
  // The gateway's sign-out page is not running here; the request for it is
  // what shows the handover.
  await page.route(`${logoutUrl.split('?')[0]}**`, (route) => route.fulfill({ status: 200, body: 'gateway sign-out' }));

  let result = 'handed over';
  let step = 'open PLANKA';
  try {
    await page.goto(base);
    step = 'open the user menu';
    await page.click('[class*="userName"]', { timeout: 30000 });
    step = 'sign out';
    const handover = page.waitForRequest((request) => request.url() === logoutUrl, { timeout: 15000 });
    await page.getByText('Log Out', { exact: true }).click();
    step = 'reach the gateway sign-out';
    await handover;
  } catch (error) {
    result = `failed to ${step}: ${error.message.split('\n')[0]}`;
  }
  console.log(result);
  await browser.close();
})();
