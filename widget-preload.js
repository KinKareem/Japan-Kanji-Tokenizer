const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widget", {
  onLang: (cb) => ipcRenderer.on("lang", (_e, c) => cb(c)),
  action: (a) => ipcRenderer.send("widget:action", a),
  dragStart: () => ipcRenderer.send("widget:dragstart"),
  drag: (dx, dy) => ipcRenderer.send("widget:drag", { dx, dy }),
  dragEnd: () => ipcRenderer.send("widget:dragend"),
});