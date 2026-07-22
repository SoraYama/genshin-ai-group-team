import { createHash } from 'node:crypto';
import { app, BrowserWindow, session } from 'electron';
import { request } from 'undici';
import {
  deviceHeadersFromCookie,
  type MiyousheVerificationProviderResult
} from '../miyoushe-game-record.js';
import { MIYOUSHE_UA } from '../miyoushe-client.js';
import { MIYOUSHE_LOGIN_PARTITION } from '../miyoushe-login-window.js';
import { CLIENT_TYPE_WEB, MIYOUSHE_APP_VERSION_WEB, signDsV2 } from './ds-token.js';

const CREATE_VERIFICATION_URL =
  'https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/createVerification';
const VERIFY_VERIFICATION_URL =
  'https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/verifyVerification';
const VERIFICATION_QUERY = 'is_high=true';
const GEETEST_SCRIPT_URL = 'https://static.geetest.com/static/js/gt.0.5.2.js';
const CAPTCHA_TIMEOUT_MS = 180_000;
const VERIFICATION_HTTP_TIMEOUT_MS = 10_000;

interface GeetestChallenge {
  gt: string;
  challenge: string;
  new_captcha: number;
  success: number;
}

interface GeetestValidation {
  geetest_challenge: string;
  geetest_validate: string;
  geetest_seccode: string;
}

interface VerificationEnvelope {
  retcode?: number;
  message?: string;
  data?: unknown;
}

interface VerificationSubmission {
  finalChallenge?: string;
  retcode?: number;
  message?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSuccessfulHttp(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function isAllowedChallengePath(value: string): boolean {
  return /^\/game_record\/app\/genshin\/api\/[A-Za-z0-9/_-]+$/.test(value);
}

function safeMessage(value: string | undefined): string {
  return (value ?? '').replace(/[\r\n]/g, ' ').slice(0, 100);
}

export function buildVerificationBody(
  validation: GeetestValidation
): Record<string, string> {
  return {
    geetest_challenge: validation.geetest_challenge,
    geetest_validate: validation.geetest_validate,
    geetest_seccode: validation.geetest_seccode.endsWith('|jordan')
      ? validation.geetest_seccode
      : `${validation.geetest_validate}|jordan`
  };
}

export function parseCreatedChallenge(
  statusCode: number,
  envelope: VerificationEnvelope
): GeetestChallenge | undefined {
  if (!isSuccessfulHttp(statusCode) || envelope.retcode !== 0 || !isObject(envelope.data)) {
    return undefined;
  }
  const data = envelope.data;
  if (
    typeof data['gt'] !== 'string' ||
    typeof data['challenge'] !== 'string' ||
    typeof data['new_captcha'] !== 'number' ||
    typeof data['success'] !== 'number'
  ) {
    return undefined;
  }
  return {
    gt: data['gt'],
    challenge: data['challenge'],
    new_captcha: data['new_captcha'],
    success: data['success']
  };
}

export function parseVerifiedChallenge(
  statusCode: number,
  envelope: VerificationEnvelope
): string | undefined {
  if (!isSuccessfulHttp(statusCode) || envelope.retcode !== 0 || !isObject(envelope.data)) {
    return undefined;
  }
  return typeof envelope.data['challenge'] === 'string'
    ? envelope.data['challenge']
    : undefined;
}

export class MiyousheVerificationService {
  private readonly partition: string;
  private inflight?: { key: string; promise: Promise<MiyousheVerificationProviderResult> };

  constructor(partition = MIYOUSHE_LOGIN_PARTITION) {
    this.partition = partition;
  }

  async requestHeaders(
    cookie: string,
    challengePath: string
  ): Promise<MiyousheVerificationProviderResult> {
    if (!isAllowedChallengePath(challengePath)) {
      return { ok: false, message: '米游社安全验证路径无效' };
    }
    const key = createHash('sha256')
      .update(cookie)
      .update('\0')
      .update(challengePath)
      .digest('hex');
    if (this.inflight?.key === key) return this.inflight.promise;
    if (this.inflight) {
      return { ok: false, message: '已有另一项米游社安全验证正在进行，请完成后重试' };
    }

    const promise = this.run(cookie, challengePath)
      .catch(() => ({ ok: false as const, message: '米游社安全验证失败，请稍后重试' }))
      .finally(() => {
        if (this.inflight?.promise === promise) this.inflight = undefined;
      });
    this.inflight = { key, promise };
    return promise;
  }

  private async run(
    cookie: string,
    challengePath: string
  ): Promise<MiyousheVerificationProviderResult> {
    const challenge = await this.createChallenge(cookie, challengePath);
    if (!challenge) return { ok: false, message: '米游社安全验证创建失败，请稍后重试' };

    const validation = await this.solveChallenge(challenge);
    if (!validation) return { ok: false, message: '米游社安全验证已取消或超时' };

    const submission = await this.submitValidation(cookie, challengePath, validation);
    if (submission.finalChallenge) {
      return { ok: true, headers: { 'x-rpc-challenge': submission.finalChallenge } };
    }
    return {
      ok: false,
      retcode: submission.retcode,
      message:
        submission.retcode === 10306
          ? '米游社未接受本次安全验证（10306）；已保留本地角色缓存，请稍后重试或重新登录'
          : submission.message || '米游社未接受本次安全验证；已保留本地角色缓存'
    };
  }

  private buildHeaders(cookie: string, challengePath: string, ds: string) {
    return {
      cookie,
      DS: ds,
      'user-agent': MIYOUSHE_UA,
      'x-rpc-app_version': MIYOUSHE_APP_VERSION_WEB,
      'x-rpc-client_type': CLIENT_TYPE_WEB,
      'x-rpc-challenge_game': '2',
      'x-rpc-challenge_path': challengePath,
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://webstatic.mihoyo.com',
      Referer: 'https://webstatic.mihoyo.com/'
    };
  }

  private async createChallenge(
    cookie: string,
    challengePath: string
  ): Promise<GeetestChallenge | undefined> {
    const ds = signDsV2({ query: VERIFICATION_QUERY, body: '', clientType: CLIENT_TYPE_WEB });
    const response = await request(`${CREATE_VERIFICATION_URL}?${VERIFICATION_QUERY}`, {
      method: 'GET',
      headers: {
        ...this.buildHeaders(cookie, challengePath, ds.header),
        ...deviceHeadersFromCookie(cookie)
      },
      bodyTimeout: VERIFICATION_HTTP_TIMEOUT_MS,
      headersTimeout: VERIFICATION_HTTP_TIMEOUT_MS
    });
    const envelope = readEnvelope(await response.body.text());
    const challenge = parseCreatedChallenge(response.statusCode, envelope);
    if (!challenge) {
      console.warn(
        `[miyoushe-verification] create failed HTTP ${response.statusCode} ` +
          `retcode=${envelope.retcode ?? '?'} message=${safeMessage(envelope.message)}`
      );
    }
    return challenge;
  }

  private async submitValidation(
    cookie: string,
    challengePath: string,
    validation: GeetestValidation
  ): Promise<VerificationSubmission> {
    const body = JSON.stringify(buildVerificationBody(validation));
    const ds = signDsV2({ query: '', body, clientType: CLIENT_TYPE_WEB });
    const response = await request(VERIFY_VERIFICATION_URL, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(cookie, challengePath, ds.header),
        ...deviceHeadersFromCookie(cookie),
        'content-type': 'application/json;charset=UTF-8'
      },
      body,
      bodyTimeout: VERIFICATION_HTTP_TIMEOUT_MS,
      headersTimeout: VERIFICATION_HTTP_TIMEOUT_MS
    });
    const envelope = readEnvelope(await response.body.text());
    const finalChallenge = parseVerifiedChallenge(response.statusCode, envelope);
    console.info(
      `[miyoushe-verification] submit HTTP ${response.statusCode} ` +
        `retcode=${envelope.retcode ?? '?'} accepted=${Boolean(finalChallenge)} ` +
        `challengeLength=${validation.geetest_challenge.length} ` +
        `validateLength=${validation.geetest_validate.length}` +
        (envelope.message ? ` message="${safeMessage(envelope.message)}"` : '')
    );
    return {
      finalChallenge,
      retcode: envelope.retcode,
      message: envelope.message
    };
  }

  private async solveChallenge(
    challenge: GeetestChallenge
  ): Promise<GeetestValidation | undefined> {
    const win = new BrowserWindow({
      show: true,
      width: 520,
      height: 640,
      autoHideMenuBar: true,
      title: '米游社安全验证',
      backgroundColor: '#f5f3ed',
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('data:text/html')) event.preventDefault();
    });
    win.on('page-title-updated', (event) => event.preventDefault());
    win.center();
    win.show();
    win.setAlwaysOnTop(true, 'floating');
    win.focus();
    app.focus({ steal: true });
    setTimeout(() => {
      if (!win.isDestroyed()) win.setAlwaysOnTop(false);
    }, 2_000);

    const serialized = JSON.stringify(challenge)
      .replaceAll('<', '\\u003c')
      .replaceAll('\u2028', '\\u2028')
      .replaceAll('\u2029', '\\u2029');
    const html = verificationHtml();

    return new Promise<GeetestValidation | undefined>((resolve) => {
      let settled = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (result?: GeetestValidation) => {
        if (settled) return;
        settled = true;
        if (poll) clearInterval(poll);
        if (timeout) clearTimeout(timeout);
        if (!win.isDestroyed()) {
          win.removeAllListeners('closed');
          win.close();
        }
        resolve(result);
      };

      poll = setInterval(() => {
        if (win.isDestroyed()) return finish();
        void win.webContents
          .executeJavaScript('window.__GTA_RESULT__', true)
          .then((value: unknown) => {
            if (!isObject(value)) return;
            if (
              typeof value['geetest_challenge'] === 'string' &&
              typeof value['geetest_validate'] === 'string' &&
              typeof value['geetest_seccode'] === 'string'
            ) {
              finish({
                geetest_challenge: value['geetest_challenge'],
                geetest_validate: value['geetest_validate'],
                geetest_seccode: value['geetest_seccode']
              });
            }
          })
          .catch(() => {});
      }, 300);
      timeout = setTimeout(() => finish(), CAPTCHA_TIMEOUT_MS);
      win.on('closed', () => finish());

      void win
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        .then(async () => {
          const ses = session.fromPartition(this.partition);
          const scriptResponse = await ses.fetch(GEETEST_SCRIPT_URL, {
            headers: { 'user-agent': MIYOUSHE_UA }
          });
          if (!scriptResponse.ok) {
            throw new Error(`Geetest script HTTP ${scriptResponse.status}`);
          }
          const script = await scriptResponse.text();
          await win.webContents.executeJavaScript(script, true);
          if (win.isDestroyed()) return;
          await win.webContents.executeJavaScript(geetestBootstrapScript(serialized), true);
        })
        .catch((error: unknown) => {
          console.warn(
            `[miyoushe-verification] component load failed: ` +
              `${error instanceof Error ? error.message.slice(0, 160) : 'unknown error'}`
          );
          if (!win.isDestroyed()) {
            void win.webContents
              .executeJavaScript(
                `document.getElementById('status').textContent = '验证组件加载失败，请关闭窗口后重试。'`,
                true
              )
              .catch(() => {});
          }
        });
    });
  }
}

function readEnvelope(text: string): VerificationEnvelope {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? (parsed as VerificationEnvelope) : {};
  } catch {
    return {};
  }
}

function verificationHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://static.geetest.com https://*.geetest.com https://*.geevisit.com; connect-src https://*.geetest.com https://*.geevisit.com; img-src data: https://*.geetest.com https://*.geevisit.com; style-src 'unsafe-inline' https://*.geetest.com https://*.geevisit.com; frame-src https://*.geetest.com https://*.geevisit.com" />
  <title>米游社安全验证</title>
  <style>
    body { margin: 0; padding: 40px 28px; color: #32343a; background: #f5f3ed; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 420px; margin: 0 auto; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    p { color: #686b73; line-height: 1.7; }
    #status { margin-top: 24px; padding: 14px; border: 1px solid #c7b98b; background: #fff; }
  </style>
</head>
<body>
  <main>
    <h1>米游社安全验证</h1>
    <p>请在弹出的极验面板中完成验证。成功后本窗口会自动关闭并重试角色详情。</p>
    <div id="status">正在加载验证组件…</div>
  </main>
</body>
</html>`;
}

function geetestBootstrapScript(serializedChallenge: string): string {
  return `(() => {
    window.__GTA_RESULT__ = null;
    const challenge = ${serializedChallenge};
    const status = document.getElementById('status');
    if (typeof window.initGeetest !== 'function') throw new Error('initGeetest unavailable');
    window.initGeetest({
      protocol: 'https://',
      gt: challenge.gt,
      challenge: challenge.challenge,
      new_captcha: challenge.new_captcha !== 0,
      offline: challenge.success === 0,
      api_server: 'api.geetest.com',
      product: 'bind'
    }, (captcha) => {
      captcha.onReady(() => {
        status.textContent = '验证组件已就绪，请按提示完成操作。';
        captcha.verify();
      });
      captcha.onSuccess(() => {
        window.__GTA_RESULT__ = captcha.getValidate();
        status.textContent = '验证成功，正在返回应用…';
      });
      captcha.onError(() => {
        status.textContent = '验证组件出错，请关闭窗口后重试。';
      });
    });
  })()`;
}
