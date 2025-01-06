declare global {
  namespace NodeJS {
    interface ProcessEnv {
      PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH: string;
      APP_API_KEY: string;
    }
  }
}

export type {};
