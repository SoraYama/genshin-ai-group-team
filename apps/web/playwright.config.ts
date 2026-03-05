import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173'
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    port: 4173,
    reuseExistingServer: true,
    timeout: 60_000
  }
});
