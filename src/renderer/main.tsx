import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Self-hosted fonts (Electron offline-friendly).
// Noto Sans SC = Source Han Sans SC (OFL), the closest free analogue to the
// proprietary GI_*_Web family used by Genshin's official web UI.
import '@fontsource/noto-sans-sc/chinese-simplified-400.css';
import '@fontsource/noto-sans-sc/chinese-simplified-500.css';
import '@fontsource/noto-sans-sc/chinese-simplified-700.css';
import '@fontsource/noto-sans-sc/chinese-simplified-900.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';

import App from './App';
import { I18nProvider } from './i18n';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element missing in index.html');
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>
);
