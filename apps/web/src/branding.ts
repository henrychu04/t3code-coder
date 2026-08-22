export const HOSTED_APP_CHANNEL = null;
export const HOSTED_APP_CHANNEL_LABEL = null;
export const APP_BASE_NAME = "T3 Coder";
export const APP_STAGE_LABEL = import.meta.env.DEV ? "Dev" : "";
export const APP_DISPLAY_NAME = APP_STAGE_LABEL
  ? `${APP_BASE_NAME} ${APP_STAGE_LABEL}`
  : APP_BASE_NAME;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
