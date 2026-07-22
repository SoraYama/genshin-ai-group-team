/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GTA_ENABLE_LEGACY_ADVISOR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
