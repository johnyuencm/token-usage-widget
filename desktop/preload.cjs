"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widgetBridge", {
  close: () => ipcRenderer.invoke("widget:close"),
  openDashboard: () => ipcRenderer.invoke("widget:open-dashboard"),
  ensureServer: () => ipcRenderer.invoke("widget:ensure-server"),
  fitContent: (payload) => ipcRenderer.invoke("widget:fit-content", payload),
  setPointerInside: (inside) => ipcRenderer.invoke("widget:pointer", Boolean(inside)),
  quit: () => ipcRenderer.invoke("widget:quit"),
});
