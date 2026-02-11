/// <reference types="vite/client" />

declare global {
  interface Window {
    desktopApi: {
      getConfig: () => Promise<any>;
      getRelaySettings: () => Promise<any>;
      setRelaySettings: (relaySettings: { telegramBotToken?: string; relayBotUsername?: string }) => Promise<any>;
      setRelayBaseUrl: (relayBaseUrl: string) => Promise<any>;
      checkRelayHealth: () => Promise<any>;
      getHealth: () => Promise<any>;
      startPairing: () => Promise<any>;
      checkPairingStatus: (pairingSessionId: string) => Promise<any>;
      listThreads: () => Promise<any>;
      bindThread: (threadId: string) => Promise<any>;
      getCurrentStatus: () => Promise<any>;
      serviceControl: (action: 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall') => Promise<any>;
      getRelayServiceStatus: () => Promise<any>;
      repairLocalRelay: () => Promise<any>;
      clearPairing: () => Promise<any>;
      reconnectRelay: () => Promise<any>;
    };
  }
}

export {};
