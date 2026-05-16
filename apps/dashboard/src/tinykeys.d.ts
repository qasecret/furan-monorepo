// Shim: tinykeys ships type declarations but its package.json `exports`
// field omits a `types` condition, so TypeScript's bundler resolver
// cannot find them at the public entry point. Mirror the public surface
// the dashboard actually uses (subscribe-style `tinykeys(window, map)`).
declare module "tinykeys" {
  export type KeyBindingPress = [mods: string[], key: string | RegExp];
  export interface KeyBindingMap {
    [keybinding: string]: (event: KeyboardEvent) => void;
  }
  export interface KeyBindingHandlerOptions {
    timeout?: number;
  }
  export interface KeyBindingOptions extends KeyBindingHandlerOptions {
    event?: "keydown" | "keyup";
    capture?: boolean;
  }
  export function tinykeys(
    target: Window | HTMLElement,
    keyBindingMap: KeyBindingMap,
    options?: KeyBindingOptions,
  ): () => void;
  export function createKeybindingsHandler(
    keyBindingMap: KeyBindingMap,
    options?: KeyBindingHandlerOptions,
  ): EventListener;
  export function parseKeybinding(str: string): KeyBindingPress[];
  export function matchKeyBindingPress(
    event: KeyboardEvent,
    press: KeyBindingPress,
  ): boolean;
}
