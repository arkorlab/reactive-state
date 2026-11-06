import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** The application a compiled component's `@/` imports name in the suites (`tsconfig.json`). */
const APPLICATION = fileURLToPath(new URL('test/support/app/', import.meta.url));

/** Node by default; the React binding's tests opt into jsdom with a docblock. */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^@\//u, replacement: APPLICATION }] },
  test: {
    name: 'reactive-state',
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // The Durable Object's suites run inside workerd (`vitest.workers.config.mts`).
    exclude: ['test/cloudflare/**'],
  },
});
