export type ScenarioUnavailableReason =
  | 'production-source-not-configured'
  | 'production-config-invalid'
  | 'production-data-unavailable'
  | 'development-sample-invalid';

export interface ScenarioUnavailableCopy {
  title: string;
  body: string;
  actionHint: string;
}

const COPY: Record<
  'zh' | 'en',
  Record<ScenarioUnavailableReason, ScenarioUnavailableCopy>
> = {
  zh: {
    'production-source-not-configured': {
      title: '正式挑战资料源尚未接入',
      body: '应用尚未配置经过签名验证的正式挑战资料源。',
      actionHint: '这不是账号或智能服务设置问题，需要维护者接入资料发布链。'
    },
    'production-config-invalid': {
      title: '正式挑战资料配置无效',
      body: '应用配置的挑战资料地址或验签公钥无效。',
      actionHint: '请维护者检查 Manifest URL 与 Ed25519 公钥。'
    },
    'production-data-unavailable': {
      title: '正式挑战资料更新失败',
      body: '已配置的数据源没有返回可通过验证的当前资料。',
      actionHint: '请维护者检查网络、签名、资料版本与有效期。'
    },
    'development-sample-invalid': {
      title: '演练资料校验失败',
      body: '开发演练资料没有通过完整性检查。',
      actionHint: '这只影响开发演练，请维护者检查随包样例。'
    }
  },
  en: {
    'production-source-not-configured': {
      title: 'Official challenge data is not connected',
      body: 'The app has no configured source for signed official challenge data.',
      actionHint: 'This is a maintainer setup task, not an account or smart-service setting.'
    },
    'production-config-invalid': {
      title: 'Official challenge data configuration is invalid',
      body: 'The configured challenge-data URL or verification key is invalid.',
      actionHint: 'A maintainer must check the Manifest URL and Ed25519 public key.'
    },
    'production-data-unavailable': {
      title: 'Official challenge data could not be updated',
      body: 'The configured source did not provide a current version that passed verification.',
      actionHint: 'A maintainer must check the network, signature, data version, and validity window.'
    },
    'development-sample-invalid': {
      title: 'Practice data failed verification',
      body: 'The bundled development fixture did not pass its integrity checks.',
      actionHint: 'This affects development practice only; a maintainer must check the fixture.'
    }
  }
};

export function scenarioUnavailableCopy(
  reason: ScenarioUnavailableReason,
  locale: 'zh' | 'en'
): ScenarioUnavailableCopy {
  return COPY[locale][reason];
}
