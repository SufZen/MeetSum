/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("meetSumCapture", {
  readConfig: () => ipcRenderer.invoke("config:read"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  listSources: () => ipcRenderer.invoke("sources:list"),
  listSpool: () => ipcRenderer.invoke("spool:list"),
  saveCapture: (payload) => ipcRenderer.invoke("capture:save", payload),
  uploadCapture: (captureId) => ipcRenderer.invoke("capture:upload", captureId),
  openSpoolFolder: () => ipcRenderer.invoke("external:open-spool"),
})
