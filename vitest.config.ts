import { defineConfig } from 'vitest/config';

// Scope the suite to this repo's tests. Without an explicit include, vitest's
// default glob also sweeps unrelated projects dropped into local-only ignored
// directories (e.g. .inbox/), whose tests neither belong to nor pass in this
// environment.
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});
