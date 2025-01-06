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

  page.pause();

  console.log("handling login...");
  await handleLogin(page);

  const title = await page.title();
  if (title !== "SUNAT - Menú SOL") {
    throw new Error(`Unexpected page title: ${title}`);
  }

  console.log("mitigating possible redundant menu items...");
  await mitigateRedundantMenuItems(page);

  console.log("navigating to electronic sales and revenue management...");
  await menuToElectronicSalesAndRevenueManagement(page);

  const anyFrame = page.frame({ url: /ww1.sunat.gob.pe/ });
  if (!anyFrame) {
    throw new Error("frame for ww1.sunat.gob.pe was not found");
  }

  await anyFrame.goto("https://e-factura.sunat.gob.pe");
  await anyFrame.waitForLoadState("networkidle");

  const sunatToken = await anyFrame.evaluate(async () =>
    window.sessionStorage.getItem("SUNAT.token"),
  );

  const getReceiptsData = async (
    bookCode: "140000" | "080000",
  ): Promise<string> => {
    const response = await fetch(
      `https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rvierce/resumen/web/resumencomprobantes/202412/1/1/exporta?codLibro=${bookCode}`,
      {
        credentials: "include",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.5",
          authorization: `Bearer ${sunatToken}`,
          "Sec-GPC": "1",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-site",
          Priority: "u=0",
        },
        referrer: "https://e-factura.sunat.gob.pe/",
        method: "GET",
        mode: "cors",
      },
    );

    return await response.text();
  };

  const summary = await getReceiptsData("080000");
  console.log("summary:", summary);

  console.log("waiting...");

  await Bun.sleep(DEFAULT_TIMEOUT_MS * 5);

  await browser.close();
};

const menuToElectronicSalesAndRevenueManagement = async (menuPage: Page) => {
  const must$ = async (selector: string) => await pageMust$(menuPage, selector);

  const service2Option = await must$("#divOpcionServicio2");
  await service2Option.click();

  const SIRE_LABEL = "Sistema Integrado de Registros Electronicos";
  const sireOption = menuPage.getByText(SIRE_LABEL);
  await sireOption.click();

  const sireElectronicRecords = await must$(
    "#nivel1Cuerpo_60 .nivel2 .spanNivelDescripcion", // AKA Registros Electronicos
  );
  await sireElectronicRecords.click();

  await menuPage.getByText("Registro de Ventas e Ingresos Electronico").click();
  await menuPage.getByText("Gestión de Ventas e Ingresos Electrónicos").click();

  await menuPage.waitForLoadState("networkidle");

  const appFrame = menuPage.frameLocator("#iframeApplication");
  if (!appFrame) throw new Error("main frame not found");

  const adviceModal = appFrame.getByText("×", { exact: true }); // if advice modal is open
  const isAdviceModalOpen = await adviceModal.isVisible();
  if (isAdviceModalOpen) await adviceModal.click();
};

// Registro de Compras Electronico
// -> Gestion de Compras

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

  let suggestionInnerText = "";

  try {
    suggestionInnerText = await suggestionLocator.innerText({
      timeout: 3000,
    });
  } catch (error) {
    console.log(
      "skipping mitigation...",
      error instanceof Error ? error.message : error,
    );
    return;
  }

  const secondaryModalExists =
    suggestionInnerText.trim() === SECONDARY_MODAL_TITLE;

  if (secondaryModalExists) {
    const submitButton = campaignFrame.getByRole("button", {
      name: /Finalizar/i,
    });
    await submitButton.click();
  }

  console.log("skipping secondary modal...");

  const skipButton = campaignFrame.getByText("Continuar sin confirmar");

  await skipButton.click({ timeout: 3000 });
};

await main();
