declare global {
  namespace NodeJS {
    interface ProcessEnv {
      PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH: string;
      APP_API_KEY: string;
      APP_REDIS_CONNECTION_URL: string;
      SENTRY_DSN: string;
    }
  }
}

export type {};
