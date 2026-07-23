import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export const PRODUCTION_RENDERER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' gtai-img: data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const DEVELOPMENT_RENDERER_CSP =
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5294 ws://localhost:5294 data:; img-src 'self' gtai-img: data:";

const RENDERER_BROWSER_TARGET = 'chrome142';

export default defineConfig(({ command }) => {
  const rendererCsp = command === 'serve' ? DEVELOPMENT_RENDERER_CSP : PRODUCTION_RENDERER_CSP;
  return {
    root: 'src/renderer',
    base: './',
    plugins: [
      react(),
      {
        name: 'renderer-content-security-policy',
        transformIndexHtml(html) {
          return html.replace('__GTA_RENDERER_CSP__', rendererCsp);
        }
      }
    ],
    resolve: {
      alias: {
        '@renderer': path.resolve(__dirname, 'src/renderer'),
        '@shared': path.resolve(__dirname, 'src/shared')
      }
    },
    server: {
      port: 5294,
      strictPort: true
    },
    optimizeDeps: {
      // Dev dependency pre-bundling does not inherit build.target.
      esbuildOptions: {
        target: RENDERER_BROWSER_TARGET
      }
    },
    build: {
      // Renderer runs only in Electron 43 (Chromium 142), not in legacy browsers.
      target: RENDERER_BROWSER_TARGET,
      outDir: path.resolve(__dirname, 'dist/renderer'),
      emptyOutDir: true,
      sourcemap: command === 'serve'
    }
  };
});
