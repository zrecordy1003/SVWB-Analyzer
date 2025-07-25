export {}

declare global {
  interface Window {
    electronAPI: {
      openLink: (url: string) => void
    }
    electron: Electron
  }
}
