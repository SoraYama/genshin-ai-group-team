import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scenarioUnavailableCopy } from '../../../src/renderer/pages/Advisor/scenario-unavailable-presentation.js';

describe('scenario unavailable presentation', () => {
  it('explains that an unconfigured production source is a maintainer task', () => {
    expect(scenarioUnavailableCopy('production-source-not-configured', 'zh')).toEqual({
      title: '正式挑战资料源尚未接入',
      body: '应用尚未配置经过签名验证的正式挑战资料源。',
      actionHint: '这不是账号或智能服务设置问题，需要维护者接入资料发布链。'
    });
    expect(scenarioUnavailableCopy('production-source-not-configured', 'en')).toEqual({
      title: 'Official challenge data is not connected',
      body: 'The app has no configured source for signed official challenge data.',
      actionHint: 'This is a maintainer setup task, not an account or smart-service setting.'
    });
  });

  it('distinguishes invalid configuration, failed production data, and development fixtures', () => {
    expect(scenarioUnavailableCopy('production-config-invalid', 'zh').title).toBe(
      '正式挑战资料配置无效'
    );
    expect(scenarioUnavailableCopy('production-data-unavailable', 'zh').title).toBe(
      '正式挑战资料更新失败'
    );
    expect(scenarioUnavailableCopy('development-sample-invalid', 'zh').title).toBe(
      '演练资料校验失败'
    );
  });

  it('is wired into every challenge workspace', async () => {
    const workspaceSources = await Promise.all(
      ['AbyssWorkspace.tsx', 'StygianWorkspace.tsx', 'TheaterWorkspace.tsx'].map((file) =>
        readFile(path.resolve('src/renderer/pages/Advisor', file), 'utf8')
      )
    );

    workspaceSources.forEach((source) => {
      expect(source).toContain('scenarioUnavailableCopy');
      expect(source).toContain('copy={scenarioUnavailableCopy(');
    });
    const theaterSource = workspaceSources[2];
    if (!theaterSource) throw new Error('Theater workspace source is missing');
    expect(
      theaterSource.indexOf('copy={scenarioUnavailableCopy(view.reason, language)}')
    ).toBeGreaterThan(theaterSource.indexOf("if (view.status === 'unavailable')"));
  });
});
