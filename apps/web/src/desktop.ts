import type { RookBridge } from "@rook/contracts";

declare global {
  interface Window {
    /** Present only inside the Electron shell (see apps/desktop/src/preload.ts). */
    readonly rook?: RookBridge;
  }
}

export const desktop: RookBridge | undefined = window.rook;
