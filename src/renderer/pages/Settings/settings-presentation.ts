import type { DataManagementScope, DataManagementSummary } from '../../../shared/domain';

export function settingsLoadPresentation(failure: string, locale: 'zh' | 'en') {
  return failure
    ? {
        state: 'error' as const,
        retryLabel: locale === 'en' ? 'Retry settings' : '重新读取设置'
      }
    : {
        state: 'loading' as const,
        loadingLabel: locale === 'en' ? 'Loading…' : '正在读取…'
      };
}

export function formatStorageSize(value: number | undefined, locale: 'zh' | 'en'): string {
  if (value === undefined) return locale === 'en' ? 'Not calculated' : '暂未统计';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${trimDecimal(value / 1024)} KB`;
  return `${trimDecimal(value / (1024 * 1024))} MB`;
}

export function hasClearableChallengeCache(
  summary: Pick<DataManagementSummary, 'scenarios' | 'guideResearch'>
): boolean {
  return (
    summary.scenarios.clearableCount > 0 ||
    (summary.guideResearch.sizeBytes !== undefined && summary.guideResearch.sizeBytes > 0)
  );
}

export function dataClearCopy(
  scope: DataManagementScope,
  count: number,
  locale: 'zh' | 'en'
): { title: string; effect: string; preserves: string; action: string } {
  if (locale === 'en') {
    switch (scope) {
      case 'profiles':
        return {
          title: `Clear ${count} saved ${count === 1 ? 'profile' : 'profiles'}?`,
          effect: 'This removes locally saved characters, build panels, and sync times.',
          preserves:
            'Recommendation history, challenge data, sign-in state, and service settings stay.',
          action: `Clear ${count} saved ${count === 1 ? 'profile' : 'profiles'}`
        };
      case 'scenarios':
        return {
          title: `Clear ${count} downloaded challenge ${count === 1 ? 'file' : 'files'}?`,
          effect: 'This clears downloaded challenge data and temporary guide-research summaries.',
          preserves:
            'Character data, recommendation history, and service settings stay. Current-cycle plans may be unavailable until verifiable challenge data is downloaded again.',
          action: `Clear ${count} downloaded ${count === 1 ? 'file' : 'files'}`
        };
      case 'history':
        return {
          title: `Clear ${count} recommendation ${count === 1 ? 'record' : 'records'}?`,
          effect: `This permanently removes ${count} recommendation ${count === 1 ? 'record' : 'records'} from this device.`,
          preserves: 'Character data, challenge data, and service settings stay.',
          action: `Clear ${count} ${count === 1 ? 'record' : 'records'}`
        };
      case 'service-key':
        return {
          title: 'Clear the saved service key?',
          effect: 'New smart suggestions will be unavailable until another key is saved.',
          preserves: 'The model name, service address, character data, and history stay.',
          action: 'Clear the saved service key'
        };
    }
  }
  switch (scope) {
    case 'profiles':
      return {
        title: `清除 ${count} 份角色资料？`,
        effect: '这会删除本机保存的角色、装备面板与同步时间。',
        preserves: '不会删除推荐记录、挑战资料、登录状态或智能服务设置。',
        action: `清除 ${count} 份角色资料`
      };
    case 'scenarios':
      return {
        title: `清除 ${count} 份已下载挑战资料？`,
        effect: '这会清除已下载的挑战资料缓存和临时攻略研究摘要。',
        preserves:
          '不会删除角色资料、推荐记录或智能服务设置。重新取得可验证挑战资料前，可能无法生成本期方案。',
        action: `清除 ${count} 份已下载资料`
      };
    case 'history':
      return {
        title: `清除 ${count} 条推荐记录？`,
        effect: `这会从本机永久删除 ${count} 条推荐记录。`,
        preserves: '不会删除角色资料、挑战资料或智能服务设置。',
        action: `清除 ${count} 条推荐记录`
      };
    case 'service-key':
      return {
        title: '清除已保存的服务密钥？',
        effect: '在保存新的密钥前，应用将无法生成新的智能建议。',
        preserves: '不会删除模型名称、服务地址、角色资料或推荐记录。',
        action: '清除已保存的服务密钥'
      };
  }
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, '');
}
