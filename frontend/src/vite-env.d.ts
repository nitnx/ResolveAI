/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL for the ResolveAI backend API. Defaults to `/api` when unset. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
