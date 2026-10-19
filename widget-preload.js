const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widget", {
  onSide: (cb) => ipcRenderer.on("side", (_e, s) => cb(s)),
  action: (a) => ipcRenderer.send("widget:action", a),
  dragStart: () => ipcRenderer.send("widget:dragstart"),
  drag: (dx, dy) => ipcRenderer.send("widget:drag", { dx, dy }),
  dragEnd: () => ipcRenderer.send("widget:dragend"),
});
