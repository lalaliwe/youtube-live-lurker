const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dashboard", {
  getState: () => ipcRenderer.invoke("dashboard:get-state"),
  saveSettings: (settings) => ipcRenderer.invoke("dashboard:save-settings", settings),
  refreshUpcoming: () => ipcRenderer.invoke("dashboard:refresh-upcoming"),
  openLink: (videoId) => ipcRenderer.invoke("dashboard:open-link", videoId),
  openExternal: (url) => ipcRenderer.invoke("dashboard:open-external", url),
  openChannel: (channelId) => ipcRenderer.invoke("dashboard:open-channel", channelId),
  checkAll: () => ipcRenderer.invoke("dashboard:check-all"),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("dashboard:state", handler);
    return () => ipcRenderer.removeListener("dashboard:state", handler);
  }
});
