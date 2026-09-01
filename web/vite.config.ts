import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
