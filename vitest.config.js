import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Os arquivos de teste do servidor são CommonJS — não converter
    include: ['tests/**/*.test.js'],
    environment: 'node',
    globals: true,         // describe/it/expect globais (compatível com CommonJS)
    testTimeout: 10000,
    pool: 'forks',         // cada arquivo em processo separado pra evitar estado compartilhado do require cache
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});
