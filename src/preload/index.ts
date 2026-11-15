import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("telldo", {
  platform: process.platform,
  invoke: (method: string, ...args: unknown[]) =>
    ipcRenderer.invoke("telldo:invoke", method, ...args),
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_: unknown, event: unknown) => callback(event);
    ipcRenderer.on("telldo:event", listener);
    return () => ipcRenderer.removeListener("telldo:event", listener);
  },
});
