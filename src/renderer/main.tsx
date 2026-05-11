import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Self-hosted fonts (Electron offline-friendly).
// Noto Sans SC = Source Han Sans SC (OFL), the closest free analogue to the
// proprietary GI_*_Web family used by Genshin's official web UI.
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/700.css';
import '@fontsource/noto-sans-sc/900.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';

import App from './App';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element missing in index.html');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
