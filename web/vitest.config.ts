import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // テストはブラウザ内のモック実装（api/mock.ts）に対して回す。
    // Go サーバを立てずに、権限や業務の流れの規則を固定できるようにするため。
    // import.meta.env は define では置き換わらないため env で渡す
    env: { VITE_API: 'mock' },
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
