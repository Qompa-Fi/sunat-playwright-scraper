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
      async ({ query: credentials }) => {
        const result = await handle(browser, credentials, "080000");
        return result;
      },
      { query: credentialsSchema },
    )
    .get(
      "/purchasing-management",
      async ({ query: credentials }) => {
        const result = await handle(browser, credentials, "140000");

        return result;
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

const handle = async (
  browser: Browser,
  credentials: SunatCredentials,
  bookCode: "140000" | "080000",
) => {
  const page = await browser.newPage();
  await page.goto("https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm", {
    waitUntil: "networkidle",
  });

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
    throw new Error("SUNAT.token not found");
  }

  const summary = await getExportedData(sunatToken, bookCode);

  return summary;
};

const getExportedData = async (
  sunatToken: string,
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

const pageMust$ = async (
  page: Page,
  selector: string,
): Promise<ElementHandle<SVGElement | HTMLElement>> => {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
};

const handleLogin = async (loginPage: Page, credentials: SunatCredentials) => {
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

await main();

/**
   * Periods
   * 
  await fetch("https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rvierce/padron/web/omisos/140000/periodos", {
    "credentials": "include",
    "headers": {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0",
        "Accept": "application/json, text/plain, *\/*",
        "Accept-Language": "en-US,en;q=0.5",
        "authorization": "Bearer eyJraWQiOiJhcGkuc3VuYXQuZ29iLnBlLmtpZDAwMSIsInR5cCI6IkpXVCIsImFsZyI6IlJTMjU2In0.eyJzdWIiOiIyMDU2NjAzNjg5NSIsImF1ZCI6Ilt7XCJhcGlcIjpcImh0dHBzOlwvXC9hcGktc2lyZS5zdW5hdC5nb2IucGVcIixcInJlY3Vyc29cIjpbe1wiaWRcIjpcIlwvdjFcL2NvbnRyaWJ1eWVudGVcL21pZ2VpZ3ZcIixcImluZGljYWRvclwiOlwiMVwiLFwiZ3RcIjpcIjEwMDEwMFwifV19XSIsInVzZXJkYXRhIjp7Im51bVJVQyI6IjIwNTY2MDM2ODk1IiwidGlja2V0IjoiMTYxNDUyNTExMzYiLCJucm9SZWdpc3RybyI6IiIsImFwZU1hdGVybm8iOiIiLCJsb2dpbiI6IjIwNTY2MDM2ODk1R1JFSkVXSU4iLCJub21icmVDb21wbGV0byI6IlJFTkRFWiAtIFZPVVMgU09DSUVEQUQgQU5PTklNQSBDRVJSQURBIiwibm9tYnJlcyI6IlJFTkRFWiAtIFZPVVMgU09DSUVEQUQgQU5PTklNQSBDRVJSQURBIiwiY29kRGVwZW5kIjoiMDAyMyIsImNvZFRPcGVDb21lciI6IiIsImNvZENhdGUiOiIiLCJuaXZlbFVPIjowLCJjb2RVTyI6IiIsImNvcnJlbyI6IiIsInVzdWFyaW9TT0wiOiJHUkVKRVdJTiIsImlkIjoiIiwiZGVzVU8iOiIiLCJkZXNDYXRlIjoiIiwiYXBlUGF0ZXJubyI6IiIsImlkQ2VsdWxhciI6bnVsbCwibWFwIjp7ImlzQ2xvbiI6ZmFsc2UsImRkcERhdGEiOnsiZGRwX251bXJ1YyI6IjIwNTY2MDM2ODk1IiwiZGRwX251bXJlZyI6IjAwMjMiLCJkZHBfZXN0YWRvIjoiMDAiLCJkZHBfZmxhZzIyIjoiMDAiLCJkZHBfdWJpZ2VvIjoiMTUwMTQxIiwiZGRwX3RhbWFubyI6IjAyIiwiZGRwX3Rwb2VtcCI6IjM5IiwiZGRwX2NpaXUiOiI1NTIwNSJ9LCJpZE1lbnUiOiIxNjE0NTI1MTEzNiIsImpuZGlQb29sIjoicDAwMjMiLCJ0aXBVc3VhcmlvIjoiMCIsInRpcE9yaWdlbiI6IklUIiwicHJpbWVyQWNjZXNvIjpmYWxzZX19LCJuYmYiOjE3MzYxOTMxODUsImNsaWVudElkIjoiZTJmNzZmNWEtM2Y4MS00ZTg1LWE2ODEtYzc5YjVhNGJkNmE4IiwiaXNzIjoiaHR0cHM6XC9cL2FwaS1zZWd1cmlkYWQuc3VuYXQuZ29iLnBlXC92MVwvY2xpZW50ZXNzb2xcL2UyZjc2ZjVhLTNmODEtNGU4NS1hNjgxLWM3OWI1YTRiZDZhOFwvb2F1dGgyXC90b2tlblwvIiwiZXhwIjoxNzM2MTk2Nzg1LCJncmFudFR5cGUiOiJhdXRob3JpemF0aW9uX3Rva2VuIiwiaWF0IjoxNzM2MTkzMTg1fQ.eexo3xGYAoADIJ2KyfSUohvaKTxxl0OtAB5YL6_Gf7GFfseyDPbCqwrFLMw9RtYwqYUi4teibudjfW4pJO2FkBhKhy5-BeMlIKykKjqTal9iDYnWRaHcPqXlFtUrZqBjIOvnoVTR2BYJbrm2029TqolkytkT6EfmUNWOBDGcD_-kOyb11QZkGLggnncXR_K7HvxLVCu85HnyTCSbKcwh2Z09CfhgU-0XnRyJcsj76DMYKnwQh7tq9oG-CJFdsZqvVWSczPOZuBlQMx3yXVax7Q8xFLU23R8ToyyOxLTFKxWM9LHtuLA0x90CEPyV3aSLRukoHHSP-4hMJiSnFJlsZQ",
        "Sec-GPC": "1",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site"
    },
    "referrer": "https://e-factura.sunat.gob.pe/",
    "method": "GET",
    "mode": "cors"
});
   */
