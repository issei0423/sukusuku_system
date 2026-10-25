import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { keepMockOutOfBuild } from './build/keepMockOutOfBuild.ts';

// https://vite.dev/config/
export default defineConfig({
  // keepMockOutOfBuild：本番のビルドへモックとデモデータを入れない（中身と理由は build/keepMockOutOfBuild.ts）
  plugins: [react(), keepMockOutOfBuild()],
  server: {
    /*
     * 開発中は Vite（5173）と Go サーバ（8080）が別のポートで動く。
     * /api を Go サーバへ中継し、画面からは同一オリジンとして扱えるようにする。
     * セッションの Cookie（SameSite=Strict）を届けるためにも同一オリジンが要る。
     */
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
    },
  },
});
