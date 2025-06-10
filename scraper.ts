import type { Browser, ElementHandle, Page } from "playwright";
import type { Logger } from "@bogeychan/elysia-logger/types";

export type GetSunatTokenTargets = "sire" | "cpe" | "unified-platform";

interface GetSunatLegacyResult {
  sire: string | null;
  cpe: string | null;
}

interface GetSunatLTSResult {
  unified_platform: string | null;
}

export type GetSunatTokenResult = GetSunatLegacyResult & GetSunatLTSResult;

export interface GetSunatTokenPayload {
  sol_username: string;
  sol_key: string;
  ruc: string;
  targets: GetSunatTokenTargets[];
}

export namespace scraper {
  export const getSunatTokens = async (
    logger: Logger,
    browser: Browser,
    payload: GetSunatTokenPayload,
  ): Promise<GetSunatTokenResult | null> => {
    logger.trace("creating new page...");

    let legacyTokens: GetSunatLegacyResult | null = null;
    let ltsTokens: GetSunatLTSResult | null = null;

    if (payload.targets.includes("cpe") || payload.targets.includes("sire")) {
      legacyTokens = await resolveLegacyTokens(logger, browser, payload);
    }

    if (payload.targets.includes("unified-platform")) {
      ltsTokens = await resolveLTSTokens(logger, browser, payload);
    }

    return {
      cpe: null,
      sire: null,
      unified_platform: null,
      ...legacyTokens,
      ...ltsTokens,
    };
  };

  const resolveLegacyTokens = async (
    logger: Logger,
    browser: Browser,
    payload: GetSunatTokenPayload,
  ): Promise<GetSunatLegacyResult | null> => {
    logger.trace("creating new page...");
    const page = await browser.newPage();

    logger.trace("new page was created, navigating to sunat menu...");

    const hunt = async () => {
      await page.goto(
        "https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm",
        {
          waitUntil: "networkidle",
        },
      );

      logger.debug("handling login...");
      await handleLogin(page, payload);

      const title = await page.title();
      if (title !== "SUNAT - Menú SOL") {
        throw new Error(`Unexpected page title: ${title}`);
      }

      logger.debug("mitigating possible redundant menu items...");
      await mitigateRedundantMenuItems(logger, page);

      const resolveToken = async (): Promise<string | null> => {
        const anyFrame = page.frame({ url: /ww1.sunat.gob.pe/ });
        if (!anyFrame) {
          throw new Error("frame for ww1.sunat.gob.pe was not found");
        }

        await anyFrame.goto("https://e-factura.sunat.gob.pe");
        await anyFrame.waitForLoadState("networkidle");

        return await anyFrame.evaluate(async () =>
          window.sessionStorage.getItem("SUNAT.token"),
        );
      };

      const goBack = async () => {
        const backButton = page.getByRole("button", { name: "Ir al inicio" });
        await backButton.click();
      };

      let sireToken: string | null = null;
      let cpeToken: string | null = null;

      if (payload.targets.includes("sire")) {
        try {
          logger.debug("resolving SIRE token...");
          await goToSireMenu(page);

          sireToken = await resolveToken();
        } catch (err) {
          logger.error(
            {
              error: err instanceof Error ? err.message : JSON.stringify(err),
            },
            "got error while resolving SIRE token, skipping...",
          );
        } finally {
          logger.trace("done");
        }
      }

      await goBack();

      if (payload.targets.includes("cpe")) {
        try {
          logger.debug("resolving CPE token...");
          await goToCpeMenu(page);

          cpeToken = await resolveToken();
        } catch (err) {
          logger.error(
            {
              error: err instanceof Error ? err.message : JSON.stringify(err),
            },
            "got error while resolving CPE token, skipping...",
          );
        } finally {
          logger.trace("done");
        }
      }

      return { sire: sireToken, cpe: cpeToken };
    };

    try {
      return await hunt();
    } catch (error) {
      logger.error(
        { error },
        "got error while hunting sunat token, closing page...",
      );
      return null;
    } finally {
      await page.close();
      logger.trace("page was closed");
    }
  };

  const resolveLTSTokens = async (
    logger: Logger,
    browser: Browser,
    credentials: GetSunatTokenPayload,
  ): Promise<GetSunatLTSResult | null> => {
    logger.trace("creating new page...");
    const page = await browser.newPage();

    logger.trace("new page was created, navigating to sunat menu...");

    const huntToken = async () => {
      await page.goto(
        "https://e-menu.sunat.gob.pe/cl-ti-itmenu2/MenuInternetPlataforma.htm?exe=55.1.1.1.1",
        {
          waitUntil: "networkidle",
        },
      );

      await page.waitForLoadState("networkidle");

      logger.debug("handling login...");
      await handleLogin(page, credentials);

      const title = await page.title();
      if (title !== "SUNAT - Menú SOL") {
        throw new Error(`Unexpected page title: ${title}`);
      }

      // Esperar a que el iframe se cargue en iDivApplication
      await page.waitForSelector("#iDivApplication iframe");
      const rawHTML = await page.content();
      await page.close();
      const tokenRegex = /var\s+token\s*=\s*"([^"]+)"/;
      const match = rawHTML.match(tokenRegex);
      const sunatToken = match ? match[1] : null;

      if (!sunatToken) {
        return null;
      }

      return { unified_platform: sunatToken };
    };

    try {
      return await huntToken();
    } catch (error) {
      logger.error(
        { error },
        "got error while hunting sunat token, closing page...",
      );
      await page.close();
      logger.trace("page was closed");
      return null;
    }
  };

  const goToCpeMenu = async (menuPage: Page) => {
    const must$ = async (selector: string) =>
      await pageMust$(menuPage, selector);

    const service2Option = await must$("#divOpcionServicio2");
    await service2Option.click();

    // Click first level
    await menuPage.click("#nivel1_11");
    await menuPage.waitForSelector("#nivel2_11_38", { state: "visible" });

    // Click second level
    await menuPage.click("#nivel2_11_38");
    await menuPage.waitForSelector("#nivel3_11_38_1", { state: "visible" });

    // Click third level
    await menuPage.click("#nivel3_11_38_1");
    await menuPage.waitForSelector("#nivel4_11_38_1_1_1", { state: "visible" });

    // Click fourth level (Nueva Consulta de comprobantes de pago)
    await menuPage.click("#nivel4_11_38_1_1_1");

    await menuPage.waitForLoadState("networkidle");
  };

  const goToSireMenu = async (menuPage: Page) => {
    const must$ = async (selector: string) =>
      await pageMust$(menuPage, selector);

    const service2Option = await must$("#divOpcionServicio2");
    await service2Option.click();

    const SIRE_LABEL = "Sistema Integrado de Registros Electronicos";
    const sireOption = menuPage.getByText(SIRE_LABEL);
    await sireOption.click();

    const sireLevel2 = await must$(
      "#nivel1Cuerpo_60 .nivel2 .spanNivelDescripcion", // AKA Registros Electronicos
    );
    await sireLevel2.click();

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
    payload: GetSunatTokenPayload,
  ) => {
    const must$ = async (selector: string) =>
      await pageMust$(loginPage, selector);

    const rucInput = await must$("#txtRuc");
    await rucInput.click();
    await rucInput.fill(payload.ruc);

    const solUsernameInput = await must$("#txtUsuario");
    await solUsernameInput.click();
    await solUsernameInput.fill(payload.sol_username);

    const solKeyInput = await must$("#txtContrasena");
    await solKeyInput.click();
    await solKeyInput.fill(payload.sol_key);

    const submitButton = await must$("#btnAceptar");
    await submitButton.click();
  };

  const mitigateRedundantMenuItems = async (logger: Logger, menuPage: Page) => {
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
      logger.debug(
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

    logger.debug("skipping secondary modal...");

    const skipButton = campaignFrame.getByText("Continuar sin confirmar");

    await skipButton.click({ timeout: 3000 });
  };
}
