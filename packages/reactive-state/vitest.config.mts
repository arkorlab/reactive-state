import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** Node by default; the React binding's tests opt into jsdom with a docblock. */
export default defineConfig({
  plugins: [react()],
  test: {
    name: 'reactive-state',
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // The Durable Object's suites run inside workerd (`vitest.workers.config.mts`).
    exclude: ['test/cloudflare/**'],
  },
});
