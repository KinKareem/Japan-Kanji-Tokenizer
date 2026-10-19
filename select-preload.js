const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sel", {
  onInit: (cb) => ipcRenderer.on("init", (_e, d) => cb(d)),
  done: (rect) => ipcRenderer.send("select:done", rect),
  cancel: () => ipcRenderer.send("select:cancel"),
});
