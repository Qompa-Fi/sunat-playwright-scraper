import type { ElementHandle, Page } from "playwright";
import { chromium } from "playwright";
import Bun from "bun";

const DEFAULT_TIMEOUT_MS = 30000 * 5;

const credentials = {
  ruc: process.env.TARGET_RUC,
  sol: {
    username: process.env.TARGET_SOL_USERNAME,
    key: process.env.TARGET_SOL_KEY,
  },
};

const main = async () => {
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH,
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const page = await browser.newPage();
  await page.goto("https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm", {
    waitUntil: "networkidle",
  });

  await handleLogin(page);

  const title = await page.title();
  if (title !== "SUNAT - Menú SOL") {
    throw new Error(`Unexpected page title: ${title}`);
  }

  await mitigateRedundantMenuItems(page);

  await Bun.sleep(DEFAULT_TIMEOUT_MS * 5);

  await browser.close();
};

const pageMust$ = async (
  page: Page,
  selector: string,
): Promise<ElementHandle<SVGElement | HTMLElement>> => {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
};

const handleLogin = async (loginPage: Page) => {
  const must$ = async (selector: string) =>
    await pageMust$(loginPage, selector);

  const rucInput = await must$("#txtRuc");
  await rucInput.click();
  await rucInput.fill(credentials.ruc);

  const solUsernameInput = await must$("#txtUsuario");
  await solUsernameInput.click();
  await solUsernameInput.fill(credentials.sol.username);

  const solKeyInput = await must$("#txtContrasena");
  await solKeyInput.click();
  await solKeyInput.fill(credentials.sol.key);

  const submitButton = await must$("#btnAceptar");
  await submitButton.click();
};

const mitigateRedundantMenuItems = async (menuPage: Page) => {
  await menuPage.waitForLoadState("networkidle");

  const campaignFrame = menuPage.frameLocator("#ifrVCE");

  const secondaryModalLocator = campaignFrame.locator(
    "#modalInformativoSecundario",
  );
  const SECONDARY_MODAL_TITLE = "Informativo";
  const suggestionLocator = secondaryModalLocator.getByText(
    SECONDARY_MODAL_TITLE,
  );
  const suggestionInnerText = await suggestionLocator.innerText();
  const secondaryModalExists =
    suggestionInnerText.trim() === SECONDARY_MODAL_TITLE;

  if (secondaryModalExists) {
    const submitButton = campaignFrame.getByRole("button", {
      name: /Finalizar/i,
    });
    await submitButton.click();
  }

  const skipButton = campaignFrame.getByText("Continuar sin confirmar");
  await skipButton.click();
};

await main();
