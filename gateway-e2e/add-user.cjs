// Gateway sign-in (local modification): end-to-end browser check of the
// administration's add-user form. Under gateway sign-in the form asks for
// neither a password nor a role. This signs in as an administrator, opens the
// form, checks that it has no password field, and adds a person by email and
// name. Usage (inside the Playwright image, sharing the planka container's
// network): node add-user.cjs <email> <name>
const { chromium } = require('playwright-core');

const [email, name] = process.argv.slice(2);
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

  let result = 'added';
  let step = 'open PLANKA';
  try {
    await page.goto(base);
    step = 'open the user menu';
    await page.click('[class*="userName"]', { timeout: 30000 });
    step = 'open Administration';
    await page.getByText('Administration', { exact: true }).click();
    step = 'open the add-user form';
    await page.getByRole('button', { name: 'Add user', exact: true }).click({ timeout: 10000 });
    await page.waitForSelector('input[name="email"]', { timeout: 10000 });
    if (await page.locator('input[name="password"]').count()) {
      result = 'the form asks for a password';
    } else if (await page.locator('[class*="selectRoleButton"]').count()) {
      result = 'the form asks for a role';
    } else {
      step = 'submit the form';
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="name"]', name);
      await page.locator('form').getByRole('button', { name: 'Add user', exact: true }).click();
      await page.waitForSelector('input[name="email"]', { state: 'detached', timeout: 10000 });
    }
  } catch (error) {
    result = `failed to ${step}: ${error.message.split('\n')[0]}`;
  }
  if (errors.length > 0) {
    result = `page error: ${errors[0]}`;
  }
  console.log(result);
  await browser.close();
})();
