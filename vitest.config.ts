import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./tests/cloudflare-stub.js', import.meta.url)),
    },
  },
  test: { include: ['tests/**/*.test.{ts,js}'], environment: 'node' },
});
