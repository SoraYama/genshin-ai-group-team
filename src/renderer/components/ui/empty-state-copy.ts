export type EmptyStateKind = 'history' | 'offline' | 'service';

const COPY = {
  zh: {
    history: {
      title: '还没有推荐记录',
      body: '生成过的挑战方案会按玩法与周期保存在这台设备上。',
      actionHint: '前往“挑战配队”生成第一份方案。'
    },
    offline: {
      title: '挑战资料暂不可用',
      body: '当前没有可用于新建议的可信资料。',
      actionHint: '你仍可查看角色资料和旧方案，稍后再试。'
    },
    service: {
      title: '智能服务尚未配置',
      body: '你可以保存自己的服务密钥，或继续使用更保守的本地规则。',
      actionHint: '密钥只保存在这台设备上。'
    }
  },
  en: {
    history: {
      title: 'No recommendations yet',
      body: 'Challenge plans you create are saved on this device by mode and cycle.',
      actionHint: 'Open Challenges to create your first plan.'
    },
    offline: {
      title: 'Challenge data is unavailable',
      body: 'There is no trusted data available for a new recommendation right now.',
      actionHint: 'You can still view your roster and previous plans, then try again later.'
    },
    service: {
      title: 'Smart service is not configured',
      body: 'Save your service key, or continue with the more conservative local rules.',
      actionHint: 'The key stays on this device.'
    }
  }
} as const;

export function emptyStateCopy(kind: EmptyStateKind, locale: 'zh' | 'en') {
  return COPY[locale][kind];
}
