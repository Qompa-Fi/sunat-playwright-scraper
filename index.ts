import { createPinoLogger, logger } from "@bogeychan/elysia-logger";
import type { Browser, ElementHandle, Page } from "playwright";
import { pluginGracefulServer } from "graceful-server-elysia";
import { chromium } from "playwright";
import { Elysia, t } from "elysia";

const DEFAULT_TIMEOUT_MS = 30000 * 5;

interface SunatCredentials {
  sol_username: string;
  sol_key: string;
  ruc: string;
}

type BookCode = "140000" | "080000";

const credentialsSchema = t.Object({
  sol_username: t.String({ minLength: 3, maxLength: 8 }),
  sol_key: t.String({ minLength: 2, maxLength: 12 }),
  ruc: t.String({ minLength: 11, maxLength: 11 }),
});

const log = createPinoLogger({
  level: "debug",
  base: undefined,
});

const main = async () => {
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH,
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const appApiKey = process.env.APP_API_KEY;
  if (!appApiKey) {
    throw new Error("please set the API key");
  }

  const app = new Elysia()
    .use(logger({ level: "debug", autoLogging: true, base: undefined }))
    .guard({
      beforeHandle: async ({ headers, path, error }) => {
        log.debug({ path }, "new request was received");

        const apiKey = headers["x-api-key"];
        if (!apiKey) {
          log.warn('missing "X-API-Key" header');
          return error(401, "Unauthorized");
        }

        if (!apiKey || apiKey !== appApiKey) {
          log.warn('invalid "X-API-Key" header');
          return error(401, "Unauthorized");
        }
      },
    })
    .get(
      "/sales-and-revenue-management",
      async ({ query: credentials, error }) => {
        const token = await Scraper.getSunatToken(browser, credentials);
        if (!token) {
          log.error("sunat token could not be retrieved");
          return error(500, "Internal Server Error");
        }

        const data = await SunatAPI.getExportedData(token, "080000");
        return data;
      },
      { query: credentialsSchema },
    )
    .get(
      "/sales-and-revenue-management/periods",
      async ({ query: credentials, error }) => {
        const token = await Scraper.getSunatToken(browser, credentials);
        if (!token) {
          log.error("sunat token could not be retrieved");
          return error(500, "Internal Server Error");
        }

        const periods = await SunatAPI.getPeriods(token, "080000");
        return {
          tax_periods: periods,
        };
      },
      { query: credentialsSchema },
    )
    .get(
      "/purchasing-management",
      async ({ query: credentials, error }) => {
        const token = await Scraper.getSunatToken(browser, credentials);
        if (!token) {
          log.error("sunat token could not be retrieved");
          return error(500, "Internal Server Error");
        }

        const data = await SunatAPI.getExportedData(token, "140000");
        return data;
      },
      { query: credentialsSchema },
    )
    .get(
      "/purchasing-management/periods",
      async ({ query: credentials, error }) => {
        const token = await Scraper.getSunatToken(browser, credentials);
        if (!token) {
          log.error("sunat token could not be retrieved");
          return error(500, "Internal Server Error");
        }

        const periods = await SunatAPI.getPeriods(token, "140000");
        return {
          tax_periods: periods,
        };
      },
      { query: credentialsSchema },
    );

  app
    .use(
      pluginGracefulServer({
        onShutdown: async () => {
          log.debug("closing browser...");
          await browser.close();
        },
      }),
    )
    .listen({ port: 8750, idleTimeout: 50 }, (c) =>
      log.debug(`listening on port ${c.port}`),
    );
};

// export type ExportResult = {};

export type PeriodResult = {
  tax_periods: string[];
};

namespace SunatAPI {
  export const getPeriods = async (
    sunatToken: string,
    bookCode: string,
  ): Promise<string[]> => {
    const response = await fetch(
      `https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rvierce/padron/web/omisos/${bookCode}/periodos`,
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
        },
        referrer: "https://e-factura.sunat.gob.pe/",
        method: "GET",
        mode: "cors",
      },
    );

    interface RawPeriod {
      numEjercicio: string;
      desEstado: string;
      lisPeriodos: Array<{
        perTributario: string;
        codEstado: string;
        desEstado: string;
      }>;
    }

    const untypedData = await response.json();
    const data = untypedData as RawPeriod[];

    const taxPeriods: Array<string> = [];

    for (const item of data) {
      for (const period of item.lisPeriodos) {
        taxPeriods.push(period.perTributario);
      }
    }

    return taxPeriods;
  };

  export const getExportedData = async (
    sunatToken: string,
    bookCode: BookCode,
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
}

namespace Scraper {
  export const getSunatToken = async (
    browser: Browser,
    credentials: SunatCredentials,
  ): Promise<string | null> => {
    const page = await browser.newPage();
    await page.goto(
      "https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm",
      {
        waitUntil: "networkidle",
      },
    );

    page.pause();

    log.debug("handling login...");
    await handleLogin(page, credentials);

    const title = await page.title();
    if (title !== "SUNAT - Menú SOL") {
      throw new Error(`Unexpected page title: ${title}`);
    }

    log.debug("mitigating possible redundant menu items...");
    await mitigateRedundantMenuItems(page);

    log.debug("navigating to electronic sales and revenue management...");
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
    await page.close();

    if (!sunatToken) {
      return null;
    }

    return sunatToken;
  };

  const menuToElectronicSalesAndRevenueManagement = async (menuPage: Page) => {
    const must$ = async (selector: string) =>
      await pageMust$(menuPage, selector);

    const service2Option = await must$("#divOpcionServicio2");
    await service2Option.click();

    const SIRE_LABEL = "Sistema Integrado de Registros Electronicos";
    const sireOption = menuPage.getByText(SIRE_LABEL);
    await sireOption.click();

    const sireElectronicRecords = await must$(
      "#nivel1Cuerpo_60 .nivel2 .spanNivelDescripcion", // AKA Registros Electronicos
    );
    await sireElectronicRecords.click();

    await menuPage
      .getByText("Registro de Ventas e Ingresos Electronico")
      .click();
    await menuPage
      .getByText("Gestión de Ventas e Ingresos Electrónicos")
      .click();

    await menuPage.waitForLoadState("networkidle");

    const appFrame = menuPage.frameLocator("#iframeApplication");
    if (!appFrame) throw new Error("main frame not found");

    const adviceModal = appFrame.getByText("×", { exact: true }); // if advice modal is open
    const isAdviceModalOpen = await adviceModal.isVisible();
    if (isAdviceModalOpen) await adviceModal.click();
  };

  const pageMust$ = async (
    page: Page,
    selector: string,
  ): Promise<ElementHandle<SVGElement | HTMLElement>> => {
    const element = await page.$(selector);
    if (!element) throw new Error(`Element not found: ${selector}`);
    return element;
  };

  const handleLogin = async (
    loginPage: Page,
    credentials: SunatCredentials,
  ) => {
    const must$ = async (selector: string) =>
      await pageMust$(loginPage, selector);

    const rucInput = await must$("#txtRuc");
    await rucInput.click();
    await rucInput.fill(credentials.ruc);

    const solUsernameInput = await must$("#txtUsuario");
    await solUsernameInput.click();
    await solUsernameInput.fill(credentials.sol_username);

    const solKeyInput = await must$("#txtContrasena");
    await solKeyInput.click();
    await solKeyInput.fill(credentials.sol_key);

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
      log.debug(
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

    log.debug("skipping secondary modal...");

    const skipButton = campaignFrame.getByText("Continuar sin confirmar");

    await skipButton.click({ timeout: 3000 });
  };
}

await main();
