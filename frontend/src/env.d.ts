/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_APP_NAME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare const __RELEASE_MANIFEST__:
  | {
      appVersion: string
      sourceHash: string
      builtAt: string
      requiredDeps: { name: string; declared: string | null }[]
    }
  | undefined
