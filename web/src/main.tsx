import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { SessionProvider } from './session';
// 全画面の書体（自前で置く。外へ通信しない）。日本語は文字の範囲ごとに分かれていて、使う文字の分だけが読み込まれる（【仮置き】web/仮置き値.md）
import '@fontsource/zen-maru-gothic/700.css';
import '@fontsource/biz-udpgothic/400.css';
import '@fontsource/biz-udpgothic/700.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/screens.css';
import './styles/guardian.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
