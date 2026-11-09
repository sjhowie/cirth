/**
 * Layout state and the extension points for later features.
 *
 *  - registerSidebarPanel({ id, title, component })  adds a button + panel to the sidebar switch
 *    (Explorer is built in; the Search panel plugs in here).
 *  - setPreviewComponent(Component)  fills the preview pane beside the editor; show it with
 *    layout.previewMode = "side" | "only" ("off" hides it).
 *  - registerOverlay(Component)  mounts a component at the app root (command palette, quick open).
 */
import type { Component } from "svelte";

export interface SidebarPanel {
  id: string;
  title: string;
  component: Component;
}

export type PreviewMode = "off" | "side" | "only";

const WIDTH_KEY = "simpleeditor.sidebarWidth";

function readStoredWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v >= 160 && v <= 800 ? v : 260;
  } catch {
    return 260;
  }
}

class LayoutStore {
  sidebarVisible = $state(true);
  sidebarWidth = $state(readStoredWidth());
  activePanel = $state("explorer");
  previewMode = $state<PreviewMode>("off");
  settingsOpen = $state(false);
  panels = $state.raw<SidebarPanel[]>([]);
  overlays = $state.raw<Component[]>([]);
  previewComponent = $state.raw<Component | null>(null);

  setSidebarWidth(px: number): void {
    this.sidebarWidth = Math.min(800, Math.max(160, Math.round(px)));
    try {
      localStorage.setItem(WIDTH_KEY, String(this.sidebarWidth));
    } catch {
      /* storage unavailable: width just won't persist */
    }
  }
}

export const layout = new LayoutStore();

export function registerSidebarPanel(panel: SidebarPanel): void {
  layout.panels = [...layout.panels.filter((p) => p.id !== panel.id), panel];
}

export function showSidebarPanel(id: string): void {
  layout.activePanel = id;
  layout.sidebarVisible = true;
}

export function registerOverlay(component: Component): void {
  layout.overlays = [...layout.overlays, component];
}

export function setPreviewComponent(component: Component | null): void {
  layout.previewComponent = component;
}
