import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, session } from 'electron';

// Anti-fingerprint setup — must run before app.whenReady. mihoyo's anti-bot
// flags the default Electron UA (contains "Electron/x.x.x" and the app name)
// and `navigator.webdriver=true`; with both untouched, every game_record
// endpoint returns retcode 5003.
const SPOOFED_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
app.userAgentFallback = SPOOFED_DESKTOP_UA;
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
import { ConfigService } from './services/config-service.js';
import { AdvisorAgent } from './services/advisor-agent.js';
import { MiyousheClient } from './services/miyoushe-client.js';
import { MiyousheGameRecordClient } from './services/miyoushe-game-record.js';
import { MiyousheBrowserBridge } from './services/miyoushe/browser-bridge.js';
import { MiyousheLoginWindow } from './services/miyoushe-login-window.js';
import { LoginSessionStore, RosterSessionStore } from './services/login-session-store.js';
import { AvatarMetadataService } from './services/avatar-metadata.js';
import { EnkaClient } from './services/enka-client.js';
import { ProfileStore } from './services/profile-store.js';
import { HistoryStore } from './services/history-store.js';
import { IconProxyService, registerIconProxyScheme } from './services/icon-proxy.js';
import { ScenarioStore } from './services/scenario-store.js';
import { ScenarioRefresher } from './services/scenario-refresher.js';
import { registerConfigIpc } from './ipc/config.ipc.js';
import { registerProfileIpc } from './ipc/profile.ipc.js';
import { registerAdvisorIpc } from './ipc/advisor.ipc.js';
import { registerHistoryIpc } from './ipc/history.ipc.js';
import { registerScenarioIpc } from './ipc/scenario.ipc.js';
import { ensureAllChannelsRegistered } from './ipc/registry.js';

registerIconProxyScheme();

const isDev = process.env.NODE_ENV === 'development';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
let scenarioRefresher: ScenarioRefresher | undefined;

function resolveBundledScenarioDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scenarios');
  }
  return path.resolve(__dirname, '../../resources/scenarios');
}

async function bootstrapServices(): Promise<void> {
  const config = new ConfigService();
  const miyoushe = new MiyousheClient();
  const miyousheGameRecord = new MiyousheGameRecordClient();
  const miyousheBridge = new MiyousheBrowserBridge();
  const loginWindow = new MiyousheLoginWindow();
  const loginSessions = new LoginSessionStore();
  const rosterSessions = new RosterSessionStore();
  const metadata = new AvatarMetadataService();
  const enka = new EnkaClient(metadata);
  const profiles = new ProfileStore();
  const history = new HistoryStore();
  const advisor = new AdvisorAgent(config, profiles, history);

  const scenarioStore = new ScenarioStore({
    bundledDir: resolveBundledScenarioDir(),
    cacheDir: path.join(app.getPath('userData'), 'cache', 'scenarios')
  });
  await scenarioStore.init();
  scenarioRefresher = new ScenarioRefresher(scenarioStore);

  registerConfigIpc({ config, advisor });
  registerProfileIpc({
    miyoushe,
    miyousheGameRecord,
    miyousheBridge,
    loginWindow,
    loginSessions,
    rosterSessions,
    enka,
    store: profiles
  });
  registerAdvisorIpc({ advisor, getMainWindow: () => mainWindow });
  registerHistoryIpc({ history });
  registerScenarioIpc({ store: scenarioStore, refresher: scenarioRefresher });
  ensureAllChannelsRegistered();

  scenarioRefresher.start();

  // Recover the previous miyoushe login (if any) from the persistent partition.
  // Fire-and-forget — window creation should not wait on this.
  void seedRosterSessionsFromPersistedCookie({
    loginWindow,
    miyoushe,
    rosterSessions
  });
}

async function seedRosterSessionsFromPersistedCookie(deps: {
  loginWindow: MiyousheLoginWindow;
  miyoushe: MiyousheClient;
  rosterSessions: RosterSessionStore;
}): Promise<void> {
  try {
    const cookie = await deps.loginWindow.readPersistedCookie();
    if (!cookie) return;
    const bind = await deps.miyoushe.fetchRoles(cookie);
    if (!bind.ok || bind.roles.length === 0) {
      console.warn('[miyoushe] persisted cookie failed re-validation; skipping seed');
      return;
    }
    for (const role of bind.roles) {
      deps.rosterSessions.put(role.gameUid, cookie);
    }
    console.info(
      `[miyoushe] restored login session for ${bind.roles.length} UID(s) from persistent partition`
    );
  } catch (error) {
    console.warn('[miyoushe] seed from persisted cookie failed:', error);
  }
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
  await bootstrapServices();
  applyContentSecurityPolicy();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  scenarioRefresher?.stop();
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
