const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  onShow: (cb) => ipcRenderer.on("show", (_e, d) => cb(d)),
  onPlace: (cb) => ipcRenderer.on("place", (_e, d) => cb(d)),
  measured: (size) => ipcRenderer.send("measured", size),
  close: () => ipcRenderer.send("close"),
});
