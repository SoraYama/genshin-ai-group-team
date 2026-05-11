import type { RendererApi } from '../../shared/ipc-contract';

declare global {
  interface Window {
    api: RendererApi;
  }
}

export const api = window.api;
