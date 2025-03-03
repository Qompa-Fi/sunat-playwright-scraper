import { createPinoLogger, logger } from "@bogeychan/elysia-logger";
import type { Browser, ElementHandle, Page } from "playwright";
import { pluginGracefulServer } from "graceful-server-elysia";
import { chromium } from "playwright";
import { Elysia, t } from "elysia";
import NodeCache from "node-cache";

const DEFAULT_TIMEOUT_MS = 30000 * 5;

interface SunatCredentials {
  sol_username: string;
  sol_key: string;
  ruc: string;
}

const getGenericQuerySchema = (params?: {
  withTaxPeriod?: boolean;
  withTicketId?: boolean;
}) =>
  t.Object({
    sol_username: t.String({ minLength: 3, maxLength: 8 }),
    sol_key: t.String({ minLength: 2, maxLength: 12 }),
    ruc: t.String({ minLength: 11, maxLength: 11 }),
    ...(params?.withTaxPeriod && {
      tax_period: t.String({ minLength: 6, maxLength: 6 }),
    }),
    ...(params?.withTicketId && {
      ticket_id: t.String({ minLength: 10, maxLength: 45 }),
    }),
  });

const log = createPinoLogger({
  level: "trace",
  base: undefined,
});

const main = async () => {
  let browser: Browser | undefined;

  const cache = new NodeCache({ stdTTL: 1 });

  const appApiKey = process.env.APP_API_KEY;
  if (!appApiKey) {
    throw new Error("please set the API key");
  }

  setInterval(async () => {
    if (browser) {
      const contextsCount = browser.contexts().length;

      log.trace(`[ripper] ${contextsCount} contexts are open...`);

      if (contextsCount === 0) {
        log.trace("[ripper] closing browser...");
        await browser.close({ reason: "is unused for now" });
        browser = undefined;
        log.trace("[ripper] browser was closed");
      }
    }
  }, 1000 * 30);

  const getSunatToken = async (
    credentials: SunatCredentials,
  ): Promise<string | null> => {
    const cachedToken = cache.get<string>(credentials.ruc);
    if (cachedToken) {
      return cachedToken;
    }

    if (!browser) {
      log.trace("launching new browser...");
      browser = await chromium.launch({
        headless: false,
        executablePath: process.env.PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH,
        timeout: DEFAULT_TIMEOUT_MS,
      });
    } else {
      log.trace(`[init] ${browser.contexts().length} contexts are open...`);
    }

    const token = await Scraper.getSunatToken(browser, credentials);
    if (!token) {
      log.warn("sunat token could not be retrieved");
      return null;
    }

    log.debug("sunat token was retrieved, saving it to cache...", { token });

    const ok = cache.set(credentials.ruc, token);
    if (!ok) {
      log.warn({ ruc: credentials.ruc }, "token could not be set to cache");
    }

    log.trace(`[end] ${browser.contexts().length} contexts are open...`);

    return token;
  };

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
      "/sunat-token",
      async ({ query: credentials, error, path }) => {
        log.trace({ ruc: credentials.ruc, path }, "retrieving sunat token...");

        const token = await getSunatToken(credentials);
        if (!token) return error(500, "Internal Server Error");

        return { sunat_token: token };
      },
      { query: getGenericQuerySchema() },
    );

  app
    .use(
      pluginGracefulServer({
        onShutdown: async () => {
          if (browser) {
            log.debug("closing browser...");
            await browser.close();
            browser = undefined;
            return;
          }

          log.debug("browser was already closed!");
        },
      }),
    )
    .listen({ port: process.env.PORT || 8750, idleTimeout: 50 }, (c) =>
      log.debug(`listening on port ${c.port}`),
    );
};

namespace Scraper {
  export const getSunatToken = async (
    browser: Browser,
    credentials: SunatCredentials,
  ): Promise<string | null> => {
    log.trace("creating new page...");
    const page = await browser.newPage();

    log.trace("new page was created, navigating to sunat menu...");

    const huntToken = async () => {
      await page.goto(
        "https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm",
        {
          waitUntil: "networkidle",
        },
      );

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

    try {
      return await huntToken();
    } catch (error) {
      log.error(
        { error },
        "got error while hunting sunat token, closing page...",
      );
      await page.close();
      log.trace("page was closed");
      return null;
    }
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
