export { expect } from "@playwright/test";
export {
  test,
  type Area,
  type FuranCheckOptions,
  type FuranFixture,
  type FuranPlaywrightOptions,
} from "./fixtures.js";
export { toImageRegion, type CaptureMode } from "./regions.js";
export { default as globalSetup } from "./global-setup.js";
