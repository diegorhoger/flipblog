import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './web/e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3100',
    headless: true,
  },
  webServer: {
    command: 'node server/src/index.js',
    url: 'http://localhost:3100/api/health',
    reuseExistingServer: false,
    cwd: 'E:/Projects/flipblog',
    timeout: 30000,
    env: { PORT: '3100' },
  },
});
