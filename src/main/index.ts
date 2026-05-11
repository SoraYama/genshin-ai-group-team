import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, session } from 'electron';
import { ConfigService } from './services/config-service.js';
import { AdvisorAgent } from './services/advisor-agent.js';
import { MiyousheClient } from './services/miyoushe-client.js';
import { MiyousheLoginWindow } from './services/miyoushe-login-window.js';
import { LoginSessionStore } from './services/login-session-store.js';
import { AvatarMetadataService } from './services/avatar-metadata.js';
import { EnkaClient } from './services/enka-client.js';
import { ProfileStore } from './services/profile-store.js';
import { HistoryStore } from './services/history-store.js';
import { IconProxyService, registerIconProxyScheme } from './services/icon-proxy.js';
import { registerConfigIpc } from './ipc/config.ipc.js';
import { registerProfileIpc } from './ipc/profile.ipc.js';
import { registerAdvisorIpc } from './ipc/advisor.ipc.js';
import { registerHistoryIpc } from './ipc/history.ipc.js';
import { ensureAllChannelsRegistered } from './ipc/registry.js';

registerIconProxyScheme();

const isDev = process.env.NODE_ENV === 'development';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;

function bootstrapServices(): void {
  const config = new ConfigService();
  const miyoushe = new MiyousheClient();
  const loginWindow = new MiyousheLoginWindow();
  const loginSessions = new LoginSessionStore();
  const metadata = new AvatarMetadataService();
  const enka = new EnkaClient(metadata);
  const profiles = new ProfileStore();
  const history = new HistoryStore();
  const advisor = new AdvisorAgent(config, profiles, history);

  registerConfigIpc({ config, advisor });
  registerProfileIpc({ miyoushe, loginWindow, loginSessions, enka, store: profiles });
  registerAdvisorIpc({ advisor, getMainWindow: () => mainWindow });
  registerHistoryIpc({ history });
  ensureAllChannelsRegistered();
}

function applyContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDev
      ? "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5294 ws://localhost:5294 data:; img-src 'self' gtai-img: data:"
      : "default-src 'self'; img-src 'self' gtai-img: data:; style-src 'self' 'unsafe-inline'; script-src 'self'";

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    });
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Genshin Team Advisor',
    backgroundColor: '#16191f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (isDev) {
    void mainWindow.loadURL('http://localhost:5294');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

app.whenReady().then(async () => {
  const iconProxy = new IconProxyService();
  await iconProxy.init();
  bootstrapServices();
  applyContentSecurityPolicy();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, navigationUrl) => {
    if (!isDev || !navigationUrl.startsWith('http://localhost:5294')) {
      event.preventDefault();
    }
  });
});
