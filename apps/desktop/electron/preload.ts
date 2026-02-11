import { contextBridge, ipcRenderer } from 'electron';

const desktopApi = {
  getConfig: async () => await ipcRenderer.invoke('ipc.getConfig'),
  getRelaySettings: async () => await ipcRenderer.invoke('ipc.getRelaySettings'),
  setRelaySettings: async (relaySettings: { telegramBotToken?: string; relayBotUsername?: string }) => await ipcRenderer.invoke('ipc.setRelaySettings', relaySettings),
  setRelayBaseUrl: async (relayBaseUrl: string) => await ipcRenderer.invoke('ipc.setRelayBaseUrl', relayBaseUrl),
  checkRelayHealth: async () => await ipcRenderer.invoke('ipc.checkRelayHealth'),
  getHealth: async () => await ipcRenderer.invoke('ipc.getHealth'),
  startPairing: async () => await ipcRenderer.invoke('ipc.startPairing'),
  checkPairingStatus: async (pairingSessionId: string) => await ipcRenderer.invoke('ipc.checkPairingStatus', pairingSessionId),
  listThreads: async () => await ipcRenderer.invoke('ipc.listThreads'),
  bindThread: async (threadId: string) => await ipcRenderer.invoke('ipc.bindThread', threadId),
  getCurrentStatus: async () => await ipcRenderer.invoke('ipc.getCurrentStatus'),
  serviceControl: async (action: 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall') => await ipcRenderer.invoke('ipc.serviceControl', action),
  getRelayServiceStatus: async () => await ipcRenderer.invoke('ipc.getRelayServiceStatus'),
  repairLocalRelay: async () => await ipcRenderer.invoke('ipc.repairLocalRelay'),
  clearPairing: async () => await ipcRenderer.invoke('ipc.clearPairing'),
  reconnectRelay: async () => await ipcRenderer.invoke('ipc.reconnectRelay'),
};

contextBridge.exposeInMainWorld('desktopApi', desktopApi);

export type DesktopApi = typeof desktopApi;
