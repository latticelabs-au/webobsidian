// Minimal preload. The renderer is the existing WebObsidian SPA served over
// http://127.0.0.1 and needs no privileged bridge: it talks to the server via
// HTTP/WS exactly as in the browser. Kept as a deliberate seam for future
// desktop-only integrations (native menus, file drops, etc.).
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('webobsidianDesktop', {
  isDesktop: true,
  platform: process.platform,
});
