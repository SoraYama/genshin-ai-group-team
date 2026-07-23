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
import { MiyousheCalculatorClient } from './services/miyoushe-calculator.js';
import { MiyousheGameRecordClient } from './services/miyoushe-game-record.js';
import { MiyousheBrowserBridge } from './services/miyoushe/browser-bridge.js';
import { createMiyousheBrowserTransport } from './services/miyoushe/browser-transport.js';
import { MiyousheDeviceFpService } from './services/miyoushe/device-fp.js';
import { MiyousheVerificationService } from './services/miyoushe/verification.js';
import {
  bindDeviceFpToPartitionLifecycle,
  createMiyousheDeviceFpCooldown,
  MiyoushePartitionLifecycle,
  seedRosterSessionsFromPersistedCookie
} from './services/miyoushe/partition-lifecycle.js';
import { MIYOUSHE_LOGIN_PARTITION, MiyousheLoginWindow } from './services/miyoushe-login-window.js';
import { LoginSessionStore, RosterSessionStore } from './services/login-session-store.js';
import { AvatarMetadataService } from './services/avatar-metadata.js';
import { EnkaClient } from './services/enka-client.js';
import { ProfileStore } from './services/profile-store.js';
import { HistoryStore } from './services/history-store.js';
import { IconProxyService, registerIconProxyScheme } from './services/icon-proxy.js';
import { ScenarioStore } from './services/scenario-store.js';
import { ScenarioRefresher } from './services/scenario-refresher.js';
import { AgentSdkAdapter } from './services/agent-sdk-adapter.js';
import { createAdvisorOrchestrator } from './services/advisor-orchestrator.js';
import type { CharacterProfile } from '../shared/domain.js';
import { registerConfigIpc } from './ipc/config.ipc.js';
import { registerProfileIpc } from './ipc/profile.ipc.js';
import { registerAdvisorIpc } from './ipc/advisor.ipc.js';
import { registerAbyssAdvisorIpc } from './ipc/abyss-advisor.ipc.js';
import { registerStygianAdvisorIpc } from './ipc/stygian-advisor.ipc.js';
import { registerTheaterAdvisorIpc } from './ipc/theater-advisor.ipc.js';
import { registerHistoryIpc } from './ipc/history.ipc.js';
import { registerScenarioIpc } from './ipc/scenario.ipc.js';
import { ensureAllChannelsRegistered } from './ipc/registry.js';
import { registerUpdateIpc } from './ipc/update.ipc.js';
import { UpdateService } from './services/update-service.js';
import { UPDATE_EVENT_CHANNEL } from '../shared/ipc-contract.js';
import { AbyssScenarioService } from './services/abyss-scenario-service.js';
import { AbyssAdvisorService } from './services/abyss-advisor-service.js';
import { StygianScenarioService } from './services/stygian-scenario-service.js';
import { StygianAdvisorService } from './services/stygian-advisor-service.js';
import { TheaterScenarioService } from './services/theater-scenario-service.js';
import { TheaterAdvisorService } from './services/theater-advisor-service.js';
import { createProductionScenarioPublicationSource } from './scenario-publication/production-composition.js';
import { CharacterKnowledgeStore } from './services/character-knowledge-store.js';

const isolatedUserDataDir = process.env.GTA_E2E_USER_DATA_DIR;
if (isolatedUserDataDir) {
  app.setPath('userData', isolatedUserDataDir);
}

registerIconProxyScheme();

const isDev = process.env.NODE_ENV === 'development';
const backgroundRefreshEnabled = process.env.GTA_DISABLE_BACKGROUND_REFRESH !== '1';
const packagedSdkSmokeUrl = process.env.GTA_PACKAGED_SDK_SMOKE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
let scenarioRefresher: ScenarioRefresher | undefined;

function resolveBundledScenarioDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scenarios');
  }
  return path.resolve(__dirname, '../../resources/scenarios');
}

function resolveBundledKnowledgePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'knowledge', 'characters.v1.json')
    : path.resolve(__dirname, '../../resources/knowledge/characters.v1.json');
}

async function bootstrapServices(): Promise<void> {
  const config = new ConfigService();
  const miyoushe = new MiyousheClient();
  const miyousheCalculator = new MiyousheCalculatorClient();
  const loginWindow = new MiyousheLoginWindow();
  const partitionLifecycle = new MiyoushePartitionLifecycle();
  const deviceFpCooldown = createMiyousheDeviceFpCooldown();
  const deviceFpService = new MiyousheDeviceFpService({
    cookieWriter: partitionLifecycle.guardCookieWriter(loginWindow),
    cooldown: deviceFpCooldown
  });
  const deviceFp = bindDeviceFpToPartitionLifecycle(deviceFpService, partitionLifecycle);
  const miyousheSession = session.fromPartition(MIYOUSHE_LOGIN_PARTITION);
  const browserTransport = createMiyousheBrowserTransport(miyousheSession);
  const verification = new MiyousheVerificationService();
  // A real 1034 may use MiHoYo's supported interactive verification flow.
  // 5003 remains strictly excluded because promoting it to GeeTest was
  // rejected by the official verifier with 10306 during live validation.
  const miyousheGameRecord = new MiyousheGameRecordClient({
    browserTransport,
    deviceFp,
    verificationProvider: (cookie, challengePath) =>
      verification.requestHeaders(cookie, challengePath)
  });
  const miyousheBridge = new MiyousheBrowserBridge();
  const loginSessions = new LoginSessionStore();
  const rosterSessions = new RosterSessionStore();
  const metadata = new AvatarMetadataService();
  const enka = new EnkaClient(metadata);
  const profiles = new ProfileStore();
  const history = new HistoryStore();
  const advisor = new AdvisorAgent(config, profiles, history);
  const characterKnowledge = await CharacterKnowledgeStore.load(resolveBundledKnowledgePath());
  const productionScenarios = await createProductionScenarioPublicationSource({
    userDataDir: app.getPath('userData'),
    packagedConfigPath: app.isPackaged
      ? path.join(process.resourcesPath, 'scenario-production.json')
      : path.resolve(__dirname, '../../resources/scenario-production.json'),
    env: process.env
  });
  const abyssScenario = new AbyssScenarioService({
    enableDevelopmentScenarios: process.env.GTA_ENABLE_DEVELOPMENT_SCENARIOS === '1',
    developmentFixturePath: path.join(
      resolveBundledScenarioDir(),
      'v2',
      'development-source',
      'spiral-abyss.json'
    ),
    ...(productionScenarios.status === 'configured'
      ? { productionSnapshot: () => productionScenarios.refresh('spiral-abyss') }
      : { productionUnavailableReason: productionScenarios.reason })
  });
  const abyssAdvisor = new AbyssAdvisorService({
    runner: new AgentSdkAdapter(),
    scenarioService: abyssScenario,
    profiles,
    history,
    config,
    knowledge: characterKnowledge,
    toolLog: (event) => console.info('[abyss-business-tool]', event),
    auditLog: (event) => console.info('[abyss-advisor]', event),
    sdkEnvironment: { cwd: app.getPath('userData'), clientVersion: app.getVersion() }
  });
  const stygianScenario = new StygianScenarioService({
    enableDevelopmentScenarios: process.env.GTA_ENABLE_DEVELOPMENT_SCENARIOS === '1',
    developmentFixturePath: path.join(
      resolveBundledScenarioDir(),
      'v2',
      'development-source',
      'stygian-onslaught.json'
    ),
    ...(productionScenarios.status === 'configured'
      ? { productionSnapshot: () => productionScenarios.refresh('stygian-onslaught') }
      : { productionUnavailableReason: productionScenarios.reason })
  });
  const stygianAdvisor = new StygianAdvisorService({
    runner: new AgentSdkAdapter(),
    scenarioService: stygianScenario,
    profiles,
    history,
    config,
    knowledge: characterKnowledge,
    toolLog: (event) => console.info('[stygian-business-tool]', event),
    auditLog: (event) => console.info('[stygian-advisor]', event),
    sdkEnvironment: { cwd: app.getPath('userData'), clientVersion: app.getVersion() }
  });
  const theaterScenario = new TheaterScenarioService({
    enableDevelopmentScenarios: process.env.GTA_ENABLE_DEVELOPMENT_SCENARIOS === '1',
    developmentFixturePath: path.join(
      resolveBundledScenarioDir(),
      'v2',
      'development-source',
      'imaginarium-theater.json'
    ),
    ...(productionScenarios.status === 'configured'
      ? { productionSnapshot: () => productionScenarios.refresh('imaginarium-theater') }
      : { productionUnavailableReason: productionScenarios.reason })
  });
  const theaterAdvisor = new TheaterAdvisorService({
    runner: new AgentSdkAdapter(),
    scenarioService: theaterScenario,
    profiles,
    history,
    config,
    knowledge: characterKnowledge,
    toolLog: (event) => console.info('[theater-business-tool]', event),
    auditLog: (event) => console.info('[theater-advisor]', event),
    planningDelayMs:
      process.env.NODE_ENV === 'test'
        ? Number(process.env.GTA_E2E_THEATER_PLANNING_DELAY_MS ?? 0)
        : 0,
    sdkEnvironment: { cwd: app.getPath('userData'), clientVersion: app.getVersion() }
  });
  const updates = new UpdateService({
    enabled: app.isPackaged && !packagedSdkSmokeUrl,
    onStatus: (status) => mainWindow?.webContents.send(UPDATE_EVENT_CHANNEL, status)
  });

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
    miyousheCalculator,
    miyousheBridge,
    deviceFp,
    partitionLifecycle,
    loginWindow,
    loginSessions,
    rosterSessions,
    enka,
    store: profiles
  });
  registerAdvisorIpc({ advisor, getMainWindow: () => mainWindow });
  registerAbyssAdvisorIpc({
    scenario: abyssScenario,
    advisor: abyssAdvisor,
    getMainWindow: () => mainWindow
  });
  registerStygianAdvisorIpc({
    scenario: stygianScenario,
    advisor: stygianAdvisor,
    getMainWindow: () => mainWindow
  });
  registerTheaterAdvisorIpc({
    scenario: theaterScenario,
    advisor: theaterAdvisor,
    getMainWindow: () => mainWindow
  });
  registerHistoryIpc({ history });
  registerScenarioIpc({ store: scenarioStore, refresher: scenarioRefresher });
  registerUpdateIpc(updates);
  ensureAllChannelsRegistered();

  if (app.isPackaged) {
    void updates.check().catch(() => {
      // electron-updater also emits a sanitized error state. Startup must remain usable offline.
    });
  }

  if (backgroundRefreshEnabled) {
    scenarioRefresher.start();
  }

  // Recover the previous miyoushe login (if any) from the persistent partition.
  // Fire-and-forget — window creation should not wait on this.
  void seedRosterSessionsFromPersistedCookie({
    lifecycle: partitionLifecycle,
    loginWindow,
    deviceFp,
    miyoushe,
    rosterSessions,
    profiles
  });
}

function applyContentSecurityPolicy(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
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

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const allowedUrl = isDev
      ? 'http://localhost:5294/'
      : new URL(`file://${path.join(__dirname, '../renderer/index.html')}`).href;
    if (!targetUrl.startsWith(allowedUrl)) event.preventDefault();
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

async function runPackagedSdkSmoke(baseUrl: string): Promise<void> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 60_000);
  let sdkStderr = '';
  try {
    const sdk = new AgentSdkAdapter();
    const characters: CharacterProfile[] = [1, 2, 3, 4].map((id) => ({
      id,
      name: `Smoke ${id}`,
      element: ['Pyro', 'Hydro', 'Anemo', 'Geo'][id - 1] ?? 'None',
      rarity: 5,
      imageUrl: '',
      level: 90,
      completeness: 'basic',
      missingFields: ['stats', 'weapon', 'artifacts', 'talents'],
      provenance: {
        ownership: { source: 'miyoushe-list', fetchedAt: '2026-01-01T00:00:00Z' }
      }
    }));
    const result = await createAdvisorOrchestrator(sdk).run({
      serializedProfile: JSON.stringify({
        profile: {
          coverage: { partial: true },
          characters: characters.map(({ id, name, element }) => ({ id, name, element }))
        },
        enemies: ['smoke-enemy']
      }),
      characters,
      correlationId: 'packaged-smoke',
      side: 'single',
      emit: () => {},
      sdkOptions: {
        apiKey: 'local-packaged-smoke',
        baseUrl,
        model: 'smoke-model',
        clientVersion: app.getVersion(),
        systemPrompt: '',
        cwd: app.getPath('userData'),
        abortController,
        stderr: (data) => {
          sdkStderr = `${sdkStderr}${data}`.slice(-2_000);
        }
      }
    });
    const passed =
      result.source === 'llm' &&
      result.teams.length === 1 &&
      result.teams[0]?.characters.length === 4;
    console.log(JSON.stringify({ gate: 'packaged-sdk', status: passed ? 'passed' : 'failed' }));
    app.exit(passed ? 0 : 1);
  } catch (error) {
    const safeMessage =
      error instanceof Error
        ? error.message
            .replaceAll(baseUrl, '<local-provider>')
            .replaceAll('local-packaged-smoke', '<redacted>')
            .slice(0, 1_000)
        : 'Unknown error';
    console.error(
      JSON.stringify({
        gate: 'packaged-sdk',
        status: 'failed',
        error: error instanceof Error ? error.name : 'Error',
        message: safeMessage,
        sdkStderr: sdkStderr.replaceAll(baseUrl, '<local-provider>').slice(-1_000)
      })
    );
    app.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

void app
  .whenReady()
  .then(async () => {
    if (packagedSdkSmokeUrl) {
      await runPackagedSdkSmoke(packagedSdkSmokeUrl);
      return;
    }
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
  })
  .catch(() => {
    console.error('[bootstrap] application startup failed');
    app.exit(1);
  });

app.on('before-quit', () => {
  scenarioRefresher?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
