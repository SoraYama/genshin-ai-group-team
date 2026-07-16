import { BrowserWindow, session } from 'electron';
import { request } from 'undici';
import { MIYOUSHE_UA } from '../miyoushe-client.js';
import {
  deviceHeadersFromCookie,
  type MiyousheVerificationProviderResult
} from '../miyoushe-game-record.js';
import { MIYOUSHE_LOGIN_PARTITION } from '../miyoushe-login-window.js';
import { CLIENT_TYPE_WEB, signDsV2 } from './ds-token.js';

const CREATE_VERIFICATION_URL =
  'https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/createVerification';
const VERIFY_VERIFICATION_URL =
  'https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/verifyVerification';
const VERIFICATION_QUERY = 'is_high=true';
const GEETEST_SCRIPT_URL = 'https://static.geetest.com/static/js/gt.0.5.2.js';
const CAPTCHA_TIMEOUT_MS = 180_000;
const VERIFICATION_HTTP_TIMEOUT_MS = 10_000;
const VERIFICATION_APP_VERSION = '2.109.0';
const VERIFICATION_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/2.109.0';

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
  data?: Partial<GeetestChallenge> & { challenge?: string };
}

interface VerificationSubmission {
  finalChallenge?: string;
  retcode?: number;
  message?: string;
}

export function buildVerificationBody(validation: GeetestValidation): Record<string, string> {
  return {
    geetest_challenge: validation.geetest_challenge,
    geetest_validate: validation.geetest_validate,
    geetest_seccode: validation.geetest_seccode.endsWith('|jordan')
      ? validation.geetest_seccode
      : `${validation.geetest_validate}|jordan`
  };
}

export class MiyousheVerificationService {
  private readonly partition: string;
  private inflight?: { path: string; promise: Promise<MiyousheVerificationProviderResult> };

  constructor(partition = MIYOUSHE_LOGIN_PARTITION) {
    this.partition = partition;
  }

  async requestHeaders(
    cookie: string,
    challengePath: string
  ): Promise<MiyousheVerificationProviderResult> {
    if (this.inflight?.path === challengePath) return this.inflight.promise;
    const promise = this.run(cookie, challengePath).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = undefined;
    });
    this.inflight = { path: challengePath, promise };
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

  private async createChallenge(
    cookie: string,
    challengePath: string
  ): Promise<GeetestChallenge | undefined> {
    const ds = signDsV2({ query: VERIFICATION_QUERY, body: '', clientType: CLIENT_TYPE_WEB });
    const response = await request(`${CREATE_VERIFICATION_URL}?${VERIFICATION_QUERY}`, {
      method: 'GET',
      headers: {
        cookie,
        DS: ds.header,
        'user-agent': VERIFICATION_UA,
        'x-rpc-app_version': VERIFICATION_APP_VERSION,
        'x-rpc-client_type': CLIENT_TYPE_WEB,
        'x-rpc-challenge_game': '2',
        'x-rpc-challenge_path': challengePath,
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://webstatic.mihoyo.com',
        Referer: 'https://webstatic.mihoyo.com/',
        ...deviceHeadersFromCookie(cookie)
      },
      bodyTimeout: VERIFICATION_HTTP_TIMEOUT_MS,
      headersTimeout: VERIFICATION_HTTP_TIMEOUT_MS
    });
    const envelope = JSON.parse(await response.body.text()) as VerificationEnvelope;
    const data = envelope.data;
    if (
      response.statusCode >= 200 &&
      response.statusCode < 300 &&
      envelope.retcode === 0 &&
      typeof data?.gt === 'string' &&
      typeof data.challenge === 'string' &&
      typeof data.new_captcha === 'number' &&
      typeof data.success === 'number'
    ) {
      return {
        gt: data.gt,
        challenge: data.challenge,
        new_captcha: data.new_captcha,
        success: data.success
      };
    }
    console.warn(
      `[miyoushe-verification] create failed HTTP ${response.statusCode} retcode=${envelope.retcode ?? '?'} message=${(envelope.message ?? '').slice(0, 100)}`
    );
    return undefined;
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
        cookie,
        DS: ds.header,
        'content-type': 'application/json;charset=UTF-8',
        'user-agent': VERIFICATION_UA,
        'x-rpc-app_version': VERIFICATION_APP_VERSION,
        'x-rpc-client_type': CLIENT_TYPE_WEB,
        'x-rpc-challenge_game': '2',
        'x-rpc-challenge_path': challengePath,
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://webstatic.mihoyo.com',
        Referer: 'https://webstatic.mihoyo.com/',
        ...deviceHeadersFromCookie(cookie)
      },
      body,
      bodyTimeout: VERIFICATION_HTTP_TIMEOUT_MS,
      headersTimeout: VERIFICATION_HTTP_TIMEOUT_MS
    });
    const envelope = JSON.parse(await response.body.text()) as VerificationEnvelope;
    const finalChallenge =
      response.statusCode >= 200 &&
      response.statusCode < 300 &&
      envelope.retcode === 0 &&
      typeof envelope.data?.challenge === 'string'
        ? envelope.data.challenge
        : undefined;
    console.info(
      `[miyoushe-verification] submit HTTP ${response.statusCode} retcode=${envelope.retcode ?? '?'} accepted=${Boolean(finalChallenge)}` +
        ` challengeLength=${validation.geetest_challenge.length}` +
        ` validateLength=${validation.geetest_validate.length}` +
        (envelope.message ? ` message="${envelope.message.replace(/[\r\n]/g, ' ').slice(0, 100)}"` : '')
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
    win.on('page-title-updated', (event) => event.preventDefault());

    const serialized = JSON.stringify(challenge).replaceAll('<', '\\u003c');
    const html = `<!doctype html>
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
    <p>请在弹出的极验面板中完成验证。成功后本窗口会自动关闭并重试角色数据。</p>
    <div id="status">正在加载验证组件…</div>
  </main>
</body>
</html>`;

    return new Promise<GeetestValidation | undefined>((resolve) => {
      let settled = false;
      const finish = (result?: GeetestValidation) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        if (!win.isDestroyed()) {
          win.removeAllListeners('closed');
          win.close();
        }
        resolve(result);
      };
      const poll = setInterval(() => {
        if (win.isDestroyed()) return finish();
        void win.webContents
          .executeJavaScript('window.__GTA_RESULT__', true)
          .then((value: unknown) => {
            if (!value || typeof value !== 'object') return;
            const candidate = value as Partial<GeetestValidation>;
            if (
              typeof candidate.geetest_challenge === 'string' &&
              typeof candidate.geetest_validate === 'string' &&
              typeof candidate.geetest_seccode === 'string'
            ) {
              finish(candidate as GeetestValidation);
            }
          })
          .catch(() => {});
      }, 300);
      const timeout = setTimeout(() => finish(), CAPTCHA_TIMEOUT_MS);
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
          await win.webContents.executeJavaScript(
            `(() => {
              window.__GTA_RESULT__ = null;
              const challenge = ${serialized};
              const status = document.getElementById('status');
              if (typeof window.initGeetest !== 'function') {
                throw new Error('initGeetest unavailable');
              }
              window.initGeetest({
                protocol: 'https://',
                gt: challenge.gt,
                challenge: challenge.challenge,
                new_captcha: true,
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
            })()`,
            true
          );
        })
        .catch((error: unknown) => {
          console.warn(
            `[miyoushe-verification] component load failed: ${error instanceof Error ? error.message.slice(0, 160) : 'unknown error'}`
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
