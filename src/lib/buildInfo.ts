/** Build stamps injected by `define` in vite.config.js ("unknown" when git isn't available at build time). */
declare const __CIRTH_COMMIT__: string;
declare const __CIRTH_BUILD_DATE__: string;

export const buildCommit: string = __CIRTH_COMMIT__;
export const buildDate: string = __CIRTH_BUILD_DATE__;
