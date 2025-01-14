import { createPinoLogger, logger } from "@bogeychan/elysia-logger";
import type { Browser, ElementHandle, Page } from "playwright";
import { pluginGracefulServer } from "graceful-server-elysia";
import { chromium } from "playwright";
import { Elysia, t } from "elysia";
import NodeCache from "node-cache";

const DEFAULT_TIMEOUT_MS = 30000 * 5;

/**
 * @description A result that can end up with success(ok) or failure(not ok).
 */
type Result<T, E extends string = string> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      reason: E;
      value: undefined;
    };

/**
 * @description A result that can end up with success(ok) or failure(not ok).
 */
namespace Result {
  /**
   * @description Creates a new `Result` with the specified `value` and `ok` set to `true`.
   */
  export const ok = <T, E extends string = string>(value: T): Result<T, E> => ({
    ok: true,
    value,
  });

  /**
   * @description Creates a new `Result` with the specified `reason` and `ok` set to `false`.
   */
  export const notok = <E extends string = string>(
    reason: E,
  ): Result<never, E> => ({
    ok: false,
    reason,
    value: undefined,
  });
}

interface SunatCredentials {
  sol_username: string;
  sol_key: string;
  ruc: string;
}

type BookCode = "140000" | "080000";

const getGenericQuerySchema = (params?: { withPeriod?: boolean }) =>
  t.Object({
    sol_username: t.String({ minLength: 3, maxLength: 8 }),
    sol_key: t.String({ minLength: 2, maxLength: 12 }),
    ruc: t.String({ minLength: 11, maxLength: 11 }),
    ...(params?.withPeriod && {
      tax_period: t.String({ minLength: 6, maxLength: 6 }),
    }),
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

  const cache = new NodeCache({ stdTTL: 60 * 10 });

  const appApiKey = process.env.APP_API_KEY;
  if (!appApiKey) {
    throw new Error("please set the API key");
  }

  const getSunatToken = async (
    credentials: SunatCredentials,
  ): Promise<string | null> => {
    const cachedToken = cache.get<string>(credentials.ruc);
    if (cachedToken) {
      return cachedToken;
    }

    const token = await Scraper.getSunatToken(browser, credentials);
    if (!token) {
      log.warn("sunat token could not be retrieved");
      return null;
    }

    const ok = cache.set(credentials.ruc, token);
    if (!ok) {
      log.warn({ ruc: credentials.ruc }, "token could not be set to cache");
    }

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
      "/sales-and-revenue-management",
      async ({ query, error }) => {
        const { tax_period: taxPeriod, ...credentials } = query;

        const token = await getSunatToken(credentials);
        if (!token) return error(500, "Internal Server Error");

        const result = await SunatAPI.getTaxComplianceVerificationSummary(
          token,
          {
            book_code: "080000",
            tax_period: taxPeriod,
          },
        );

        if (!result.ok) {
          log.error(
            {
              reason: result.reason,
            },
            "something went wrong trying to fetch tax compliance verification summary...",
          );
          return error(500, "Internal Server Error");
        }

        return { data: result.value };
      },
      { query: getGenericQuerySchema({ withPeriod: true }) },
    )
    .get(
      "/sales-and-revenue-management/periods",
      async ({ query: credentials, error }) => {
        const token = await getSunatToken(credentials);
        if (!token) return error(500, "Internal Server Error");

        const result = await SunatAPI.getTaxComplianceVerificationPeriods(
          token,
          "080000",
        );
        if (!result.ok) {
          log.error(
            {
              reason: result.reason,
            },
            "something went wrong trying to fetch tax compliance verification summary...",
          );
          return error(500, "Internal Server Error");
        }

        return { tax_periods: result.value };
      },
      { query: getGenericQuerySchema() },
    )
    .get(
      "/purchasing-management",
      async ({ query, error }) => {
        const { tax_period: taxPeriod, ...credentials } = query;

        const token = await getSunatToken(credentials);
        if (!token) return error(500, "Internal Server Error");

        const result = await SunatAPI.getTaxComplianceVerificationSummary(
          token,
          {
            book_code: "140000",
            tax_period: taxPeriod,
          },
        );
        if (!result.ok) {
          log.error(
            {
              reason: result.reason,
            },
            "something went wrong trying to fetch tax compliance verification summary...",
          );
          return error(500, "Internal Server Error");
        }

        return { data: result.value };
      },
      { query: getGenericQuerySchema({ withPeriod: true }) },
    )
    .get(
      "/purchasing-management/periods",
      async ({ query: credentials, error }) => {
        const token = await getSunatToken(credentials);
        if (!token) return error(500, "Internal Server Error");

        const result = await SunatAPI.getTaxComplianceVerificationPeriods(
          token,
          "140000",
        );
        if (!result.ok) {
          log.error(
            {
              reason: result.reason,
            },
            "something went wrong trying to fetch tax compliance verification summary...",
          );
          return error(500, "Internal Server Error");
        }

        return { tax_periods: result.value };
      },
      { query: getGenericQuerySchema() },
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

namespace SunatAPI {
  const genericHeaders: HeadersInit = {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0",
    Accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    Referer: "https://e-factura.sunat.gob.pe/",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    Priority: "u=0",
  };

  /**
   * @description Retrieve the official records from the SUNAT Platform. The response items are an array in the following format: YYYYMM. Some examples are: 202405, 202201, 202112, etc.
   */
  export const getTaxComplianceVerificationPeriods = async (
    sunatToken: string,
    bookCode: BookCode,
  ): Promise<Result<string[], "bad_response">> => {
    const endpoint = `https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rvierce/padron/web/omisos/${bookCode}/periodos`;

    const response = await fetch(endpoint, {
      credentials: "include",
      headers: {
        ...genericHeaders,
        authorization: `Bearer ${sunatToken}`,
      },
      referrer: "https://e-factura.sunat.gob.pe/",
      method: "GET",
      mode: "cors",
    });

    if (!response.ok) {
      return Result.notok("bad_response");
    }

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

    return Result.ok(taxPeriods);
  };

  export interface SalesAndRevenueManagementSummary {
    documentType: string; // e.g., "01-Factura"
    totalDocuments: number; // Total number of documents
    taxableBaseDG: number; // BI Gravado DG
    igvIPMDG: number; // IGV / IPM DG
    taxableBaseDGNG: number; // BI Gravado DGNG
    igvIPMDGNG: number; // IGV / IPM DGNG
    taxableBaseDNG: number; // BI Gravado DNG
    igvIPMDNG: number; // IGV / IPM DNG
    nonTaxableValue: number; // Valor Adq. NG
    exciseTax: number; // ISC
    environmentalTax: number; // ICBPER
    otherTaxesOrCharges: number; // Otros Trib/ Cargos
    totalAmount: number; // Total CP
  }

  interface PurchasingManagementSummary {
    documentType: string; // Type of document (e.g., "01-Factura", "03-Boleta de Venta")
    totalDocuments: number; // Total number of documents
    exportInvoicedValue: number; // Valor facturado la exportación
    taxableOperationBase: number; // Base imponible de la operación gravada
    taxableBaseDiscount: number; // Dscto. de la Base Imponible
    totalIGV: number; // Monto Total del IGV
    igvDiscount: number; // Dscto. del IGV
    exemptOperationTotal: number; // Importe total de la operación exonerada
    unaffectedOperationTotal: number; // Importe total de la operación inafecta
    exciseTaxISC: number; // ISC
    riceTaxableBase: number; // Base imponible de la operación gravada con el Impuesto a las Ventas del Arroz Pilado
    riceSalesTax: number; // Impuesto a las Ventas del Arroz Pilado
    environmentalTaxICBPER: number; // ICBPER
    otherTaxesOrCharges: number; // Otros Trib/ Cargos
    totalAmount: number; // Total CP
  }

  type GetTaxComplianceVerificationSummaryDataMapping<B extends BookCode> =
    B extends "140000"
      ? PurchasingManagementSummary[]
      : B extends "080000"
        ? SalesAndRevenueManagementSummary[]
        : never;

  interface GetTaxComplianceVerificationSummaryInputs<B extends BookCode> {
    book_code: B;
    tax_period: string;
  }

  export const getTaxComplianceVerificationSummary = async <B extends BookCode>(
    sunatToken: string,
    inputs: GetTaxComplianceVerificationSummaryInputs<B>,
  ): Promise<
    Result<GetTaxComplianceVerificationSummaryDataMapping<B>, "bad_response">
  > => {
    const endpoint = `https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rvierce/resumen/web/resumencomprobantes/${inputs.tax_period}/1/1/exporta`;

    const response = await fetch(`${endpoint}?codLibro=${inputs.book_code}`, {
      credentials: "include",
      headers: {
        ...genericHeaders,
        authorization: `Bearer ${sunatToken}`,
      },
      referrer: "https://e-factura.sunat.gob.pe/",
      method: "GET",
      mode: "cors",
    });

    if (!response.ok) {
      console.log("await response.text()", await response.text());
      return Result.notok("bad_response");
    }

    const csvData = await response.text();

    const [, ...rows] = csvData.split("\n");

    if (inputs.book_code === "140000") {
      const results: PurchasingManagementSummary[] = [];

      // We skip the last row (footer)
      for (let i = 0; i < rows.length - 1; i++) {
        const row = rows[i];
        const columns = row.split(",").map((c) => c.trim());

        results.push({
          documentType: columns[0],
          totalDocuments: Number.parseInt(columns[1]),
          exportInvoicedValue: Number.parseFloat(columns[2]),
          taxableOperationBase: Number.parseFloat(columns[3]),
          taxableBaseDiscount: Number.parseFloat(columns[4]),
          totalIGV: Number.parseFloat(columns[5]),
          igvDiscount: Number.parseFloat(columns[6]),
          exemptOperationTotal: Number.parseFloat(columns[7]),
          unaffectedOperationTotal: Number.parseFloat(columns[8]),
          exciseTaxISC: Number.parseFloat(columns[9]),
          riceTaxableBase: Number.parseFloat(columns[10]),
          riceSalesTax: Number.parseFloat(columns[11]),
          environmentalTaxICBPER: Number.parseFloat(columns[12]),
          otherTaxesOrCharges: Number.parseFloat(columns[13]),
          totalAmount: Number.parseFloat(columns[14]),
        });
      }

      return Result.ok(
        results as GetTaxComplianceVerificationSummaryDataMapping<B>,
      );
    }

    const results: SalesAndRevenueManagementSummary[] = [];

    // We skip the last row (footer)
    for (let i = 0; i < rows.length - 1; i++) {
      const row = rows[i];
      const columns = row.split(",").map((c) => c.trim());

      results.push({
        documentType: columns[0],
        totalDocuments: Number.parseInt(columns[1]),
        taxableBaseDG: Number.parseFloat(columns[2]),
        igvIPMDG: Number.parseFloat(columns[3]),
        taxableBaseDGNG: Number.parseFloat(columns[4]),
        igvIPMDGNG: Number.parseFloat(columns[5]),
        taxableBaseDNG: Number.parseFloat(columns[6]),
        igvIPMDNG: Number.parseFloat(columns[7]),
        nonTaxableValue: Number.parseFloat(columns[8]),
        exciseTax: Number.parseFloat(columns[9]),
        environmentalTax: Number.parseFloat(columns[10]),
        otherTaxesOrCharges: Number.parseFloat(columns[11]),
        totalAmount: Number.parseFloat(columns[12]),
      });
    }

    return Result.ok(
      results as GetTaxComplianceVerificationSummaryDataMapping<B>,
    );
  };

  export interface QueryProcessesData {
    pagination: {
      page: number;
      per_page: number;
      total: number;
    };
    items: {
      tax_period: string;
      ticket_id: string;
      issue_date: string | null;
      start_date: string | null;
      process_code: string;
      process_label: string;
      process_status_code: string;
      process_status_label: string;
      import_file_name: string | null;
      detail: {
        ticket_id: string;
        issue_date: string;
        issue_hour: string;
        delivery_status_code: string;
        delivery_status_label: string;
        report_file_name: string | null;
      };
      files: {
        type_code: string;
        name: string;
        target_name: string;
      }[];
      subprocesses:
        | {
            code: string;
            label: string;
            status: string;
            attempts: number;
          }[]
        | null;
    }[];
  }

  export interface RawQueryProcessesData {
    paginacion: {
      page: number;
      perPage: number;
      totalRegistros: number;
    };
    registros: {
      showReporteDescarga: string;
      perTributario: string;
      numTicket: string;
      fecCargaImportacion: string | null;
      fecInicioProceso: string | null;
      codProceso: string;
      desProceso: string;
      codEstadoProceso: string;
      desEstadoProceso: string;
      nomArchivoImportacion: string | null;
      detalleTicket: {
        numTicket: string;
        fecCargaImportacion: string;
        horaCargaImportacion: string;
        codEstadoEnvio: string;
        desEstadoEnvio: string;
        nomArchivoReporte: string | null;
        cntFilasvalidada: number;
        cntCPError: number;
        cntCPInformados: number;
      };
      archivoReporte: {
        codTipoAchivoReporte: string;
        nomArchivoReporte: string;
        nomArchivoContenido: string;
      }[];
      subProcesos:
        | {
            codTipoSubProceso: string;
            desTipoSubProceso: string;
            codEstado: string;
            numIntentos: number;
          }[]
        | null;
    }[];
  }

  interface QueryProcessesInputs {
    /**
     * @description The book code to use in the request.
     */
    book_code: BookCode;
    /**
     * @description A year and month in the following format: YYYYMM. Example: 202401, 202512, 202403, etc.
     */
    start_period: string;
    /**
     * @description A year and month in the following format: YYYYMM. Example: 202401, 202512, 202403, etc. By default it has the same value that `start_period` has.
     */
    end_period?: string;
    /**
     * @description The list page to retrieve. By default is `1`.
     */
    page?: number;
    /**
     * @description The number of records to retrieve in the list to retrieve. By default is `20`.
     */
    count?: number;
  }

  //! GESTIÓN DE VENTAS E INGRESOS ELECTRÓNICOS -> 140000
  //! GESTIÓN DE COMPRAS -> 080000

  const rawQueryProcesses = async (
    sunatToken: string,
    inputs: QueryProcessesInputs,
  ): Promise<Result<RawQueryProcessesData, "bad_response">> => {
    const params = new URLSearchParams({
      perIni: inputs.start_period,
      perFin: inputs.end_period ? inputs.end_period : inputs.start_period,
      page: `${inputs.page ? inputs.page : 1}`,
      perPage: `${inputs.count ? inputs.count : 20}`,
      numTicket: "",
      codOrigenEnvio: "1",
      codLibro: inputs.book_code,
    });

    const endpoint =
      "https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets";

    const response = await fetch(`${endpoint}?${params}`, {
      headers: {
        ...genericHeaders,
        authorization: `Bearer ${sunatToken}`,
      },
      body: null,
      method: "GET",
    });

    if (!response.ok) {
      return Result.notok("bad_response");
    }

    return Result.ok(await response.json());
  };

  /**
   * @description Returns the paginated processes from the SUNAT API. You can also use `SunatAPI.queryProcesses.raw`.
   */
  export const queryProcesses = async (
    sunatToken: string,
    inputs: QueryProcessesInputs,
  ): Promise<Result<QueryProcessesData, "bad_response">> => {
    const result = await rawQueryProcesses(sunatToken, inputs);
    if (!result.ok) return result;

    const data = result.value;

    return Result.ok({
      pagination: {
        page: data.paginacion.page,
        per_page: data.paginacion.perPage,
        total: data.paginacion.totalRegistros,
      },
      items: data.registros.map((record) => ({
        tax_period: record.perTributario,
        ticket_id: record.numTicket,
        issue_date: record.fecCargaImportacion,
        start_date: record.fecInicioProceso,
        process_code: record.codProceso,
        process_label: record.desProceso,
        process_status_code: record.codEstadoProceso,
        process_status_label: record.desEstadoProceso,
        import_file_name: record.nomArchivoImportacion,
        detail: {
          ticket_id: record.detalleTicket.numTicket,
          issue_date: record.detalleTicket.fecCargaImportacion,
          issue_hour: record.detalleTicket.horaCargaImportacion,
          delivery_status_code: record.detalleTicket.codEstadoEnvio,
          delivery_status_label: record.detalleTicket.desEstadoEnvio,
          report_file_name: record.detalleTicket.nomArchivoReporte,
        },
        files: record.archivoReporte.map((file) => ({
          type_code: file.codTipoAchivoReporte,
          name: file.nomArchivoReporte,
          target_name: file.nomArchivoContenido,
        })),
        subprocesses: record.subProcesos
          ? record.subProcesos.map((sub) => ({
              code: sub.codTipoSubProceso,
              label: sub.desTipoSubProceso,
              status: sub.codEstado,
              attempts: sub.numIntentos,
            }))
          : record.subProcesos,
      })),
    });
  };

  /**
   * @description Returns the paginated processes from the SUNAT API. It doesn't perform a data structure mapping.
   */
  queryProcesses.raw = rawQueryProcesses;

  interface RequestPurchasingManagementProposalInputs {
    tax_period: string;
  }

  export interface RequestPurchasingManagementProposalData {
    ticket_id: string;
  }

  /**
   * @description Returns the ticket number so you can query the process in background while is being dispatched by the SUNAT platform.
   */
  export const requestPurchasingManagementProposal = async (
    sunatToken: string,
    inputs: RequestPurchasingManagementProposalInputs,
  ): Promise<
    Result<
      RequestPurchasingManagementProposalData,
      "no_ticket_in_response" | "bad_response"
    >
  > => {
    const EXPORT_AS_CSV_CODE = "1";

    const params = new URLSearchParams({
      codOrigenEnvio: "1",
      mtoTotalDesde: "",
      mtoTotalHasta: "",
      fecDocumentoDesde: "",
      fecDocumentoHasta: "",
      numRucAdquiriente: "",
      numCarSunat: "",
      codTipoCDP: "",
      codTipoInconsistencia: "",
      codTipoArchivo: EXPORT_AS_CSV_CODE,
    });

    const endpoint = `https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rvie/propuesta/web/propuesta/${inputs.tax_period}/exportapropuesta`;

    const response = await fetch(`${endpoint}?${params}`, {
      headers: {
        ...genericHeaders,
        Authorization: `Bearer ${sunatToken}`,
      },
      body: null,
      method: "GET",
    });

    if (!response.ok) {
      return Result.notok("bad_response");
    }

    interface RawBody {
      numTicket?: string;
    }

    const untypedBody = await response.json();
    const body = untypedBody as RawBody;

    if (!body.numTicket) {
      return Result.notok("no_ticket_in_response");
    }

    return Result.ok({ ticket_id: body.numTicket });
  };

  interface RequestSalesAndRevenueManagementProposalInputs {
    tax_period: string;
  }

  interface RequestSalesAndRevenueManagementProposalData {
    ticket_id: string;
  }

  /**
   * @description Returns the ticket number so you can query the process in background while is being dispatched by the SUNAT platform.
   */
  export const requestSalesAndRevenueManagementProposal = async (
    sunatToken: string,
    inputs: RequestSalesAndRevenueManagementProposalInputs,
  ): Promise<
    Result<
      RequestSalesAndRevenueManagementProposalData,
      "no_ticket_in_response" | "bad_response"
    >
  > => {
    const EXPORT_AS_CSV_CODE = "1";

    const endpoint = `https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rce/propuesta/web/propuesta/${inputs.tax_period}/exportacioncomprobantepropuesta`;

    const params = new URLSearchParams({
      codTipoArchivo: EXPORT_AS_CSV_CODE,
      codOrigenEnvio: "1",
    });

    const response = await fetch(`${endpoint}?${params}`, {
      headers: {
        ...genericHeaders,
        authorization: `Bearer ${sunatToken}`,
      },
      body: null,
      method: "GET",
    });
    if (!response.ok) {
      return Result.notok("bad_response");
    }

    interface RawBody {
      numTicket?: string;
    }

    const untypedBody = await response.json();
    const body = untypedBody as RawBody;

    if (!body.numTicket) {
      return Result.notok("no_ticket_in_response");
    }

    return Result.ok({ ticket_id: body.numTicket });
  };

  interface GetProcessedIGVProposalInputs {
    report_file: {
      code_type: string;
      name: string;
    };
    book_code: BookCode;
    tax_period: string;
    ticket_id: string;
    process_id: string;
  }

  export const getProcessedIGVProposal = async (
    sunatToken: string,
    inputs: GetProcessedIGVProposalInputs,
  ) => {
    const params = new URLSearchParams({
      nomArchivoReporte: inputs.report_file.name,
      codTipoArchivoReporte: inputs.report_file.code_type,
      codLibro: inputs.book_code,
      perTributario: inputs.tax_period,
      codProceso: inputs.process_id,
      numTicket: inputs.ticket_id,
    });

    const endpoint =
      "https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte";

    const response = await fetch(`${endpoint}?${params}`, {
      headers: {
        ...genericHeaders,
        authorization: `Bearer ${sunatToken}`,
      },
      body: null,
      method: "GET",
    });

    const data = await response.text();
    console.log("data", data);
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

/**
 * const params = new URLSearchParams({
    nomArchivoReporte: "LE2061036307620250110014040001EXP2.zip",
    codTipoArchivoReporte: "00",
    codLibro: "140000",
    perTributario: "202412",
    codProceso: "10",
    numTicket: "20240300000062",
  });
  */
