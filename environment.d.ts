declare global {
  namespace NodeJS {
    interface ProcessEnv {
      PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH: string;
      TARGET_RUC: string;
      TARGET_SOL_USERNAME: string;
      TARGET_SOL_KEY: string;
    }
  }
}

export type {};
