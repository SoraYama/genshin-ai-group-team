import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildLocalAbyssPlan } from '../../../src/main/services/abyss-local-optimizer.js';
import type { AgentRunTrace } from '../../../src/shared/agent-run-trace.js';
import type {
  AbyssAdvisorResult,
  AbyssPlanIssueCode
} from '../../../src/shared/abyss-advisor.js';
import type { PersistedProfile } from '../../../src/shared/domain.js';
import { AbyssResultPanel } from '../../../src/renderer/pages/Advisor/abyss/AbyssResultPanel.js';
import { AgentTraceDrawer } from '../../../src/renderer/pages/Advisor/abyss/AgentTraceDrawer.js';
import {
  ABYSS_CHARACTERS,
  abyssInput,
  abyssScenario
} from '../services/abyss-test-fixtures.js';

const profile: PersistedProfile = {
  schemaVersion: 2,
  uid: '123456789',
  nickname: '测试账号',
  source: 'merged',
  fetchedAt: '2026-07-23T00:00:00.000Z',
  characters: ABYSS_CHARACTERS,
  coverage: {
    expectedOwnedCount: 10,
    ownedCount: 10,
    detailedCount: 6,
    buildCount: 10,
    statsCount: 10,
    enkaShowcaseCount: 10,
    missingDetailCount: 4,
    partial: true
  }
};

function plannedResult(source: 'smart-service' | 'local-rules' = 'local-rules') {
  const result = buildLocalAbyssPlan({
    input: abyssInput(),
    scenario: abyssScenario(),
    characters: ABYSS_CHARACTERS
  });
  if (result.status !== 'planned') throw new Error('Expected planned fixture');
  return { ...result, source } satisfies Extract<AbyssAdvisorResult, { status: 'planned' }>;
}

function blockedResult(codes: AbyssPlanIssueCode[]) {
  const { plan: _plan, ...base } = plannedResult();
  void _plan;
  return {
    ...base,
    status: 'blocked',
    issues: codes.map((code) => ({
      code,
      path: [],
      message: `不应直接展示的内部原文 ${code}`
    }))
  } satisfies Extract<AbyssAdvisorResult, { status: 'blocked' }>;
}

function renderResult(
  overrides: Partial<React.ComponentProps<typeof AbyssResultPanel>> = {}
): string {
  return renderToStaticMarkup(
    createElement(AbyssResultPanel, {
      locale: 'en',
      profile,
      result: null,
      pending: false,
      running: false,
      activeStep: null,
      generationError: false,
      cancelled: false,
      onOpenTrace: () => undefined,
      traceButtonRef: createRef<HTMLButtonElement>(),
      ...overrides
    })
  );
}

describe('abyss result terminal states', () => {
  it('marks all eight stages complete only for a planned result, including smart-service plans', () => {
    const planned = renderResult({ result: plannedResult('smart-service') });
    const blocked = renderResult({
      result: blockedResult(['ROSTER_INSUFFICIENT']),
      activeStep: 'checking-knowledge'
    });

    expect(planned.match(/class="is-done"/gu)).toHaveLength(8);
    expect(planned).toContain('AI verified');
    expect(blocked.match(/class="is-done"/gu) ?? []).toHaveLength(2);
    expect(blocked).toContain('data-state="blocked"');
    expect(blocked).toContain('Blocked');
  });

  it('renders error and cancelled as distinct non-complete terminal states', () => {
    const errored = renderResult({
      generationError: true,
      activeStep: 'generating-teams'
    });
    const cancelled = renderResult({
      result: plannedResult(),
      cancelled: true,
      activeStep: 'checking-knowledge'
    });

    expect(errored.match(/class="is-done"/gu) ?? []).toHaveLength(5);
    expect(errored).toContain('data-state="error"');
    expect(errored).toContain('Stopped with an error');
    expect(cancelled.match(/class="is-done"/gu) ?? []).toHaveLength(2);
    expect(cancelled).toContain('data-state="cancelled"');
    expect(cancelled).toContain('Cancelled');
    expect(cancelled).not.toContain('No character overlap between halves');
  });
});

describe('blocked issue presentation', () => {
  it('maps stable issue codes to specific English meaning and recovery actions', () => {
    const html = renderResult({
      result: blockedResult([
        'SCENARIO_MISMATCH',
        'TARGET_NOT_FOUND',
        'ROSTER_INSUFFICIENT',
        'LOCK_EXCLUDE_CONFLICT',
        'PLAN_SCHEMA_INVALID'
      ])
    });

    expect(html).toContain('Challenge data changed');
    expect(html).toContain('The selected floor or chamber is no longer available');
    expect(html).toContain('Refresh challenge data or choose the target again');
    expect(html).toContain('Not enough eligible characters');
    expect(html).toContain('Update character data');
    expect(html).toContain('A character is both locked and excluded');
    expect(html).toContain('Adjust locked and excluded characters');
    expect(html).toContain('The plan could not be validated safely');
    expect(html).toContain('Review the current choices and try again');
    expect(html).not.toContain('不应直接展示的内部原文');
  });

  it('provides the same issue categories and recovery actions in Chinese', () => {
    const html = renderResult({
      locale: 'zh',
      result: blockedResult([
        'SCENARIO_MISMATCH',
        'ROSTER_INSUFFICIENT',
        'LOCK_EXCLUDE_CONFLICT',
        'PLAN_SCHEMA_INVALID'
      ])
    });

    expect(html).toContain('挑战资料已变化');
    expect(html).toContain('刷新挑战资料或重新选择目标');
    expect(html).toContain('可用角色不足');
    expect(html).toContain('更新角色资料');
    expect(html).toContain('同一角色同时被锁定与排除');
    expect(html).toContain('调整锁定与排除');
    expect(html).toContain('方案未能安全通过校验');
    expect(html).toContain('检查当前选择后重试');
  });
});

const trace: AgentRunTrace = {
  status: 'failed',
  correlationId: 'trace-test',
  startedAt: '2026-07-23T00:00:00.000Z',
  finishedAt: '2026-07-23T00:00:01.000Z',
  model: 'test-model',
  finalSource: 'blocked',
  knowledge: { trusted: 1, ephemeral: 0, unknown: 1, searched: false },
  usage: { inputTokens: 3, outputTokens: 2 },
  failure: {
    code: 'PROVIDER_ERROR',
    message: 'internal provider message',
    retryable: true
  },
  stages: [
    {
      stage: 'compose',
      status: 'failed',
      inputSummary: 'input',
      tools: [
        {
          name: 'mcp__genshin__query_team_knowledge',
          status: 'completed'
        }
      ],
      citationIds: [],
      usage: { inputTokens: 3, outputTokens: 2 },
      durationMs: 1000,
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'internal stage failure',
        retryable: true
      }
    }
  ]
};

function renderTrace(
  overrides: Partial<React.ComponentProps<typeof AgentTraceDrawer>> = {}
): string {
  return renderToStaticMarkup(
    createElement(AgentTraceDrawer, {
      open: true,
      loading: false,
      failedToLoad: false,
      trace,
      locale: 'en',
      returnFocusRef: createRef<HTMLButtonElement>(),
      onClose: () => undefined,
      ...overrides
    })
  );
}

describe('agent trace behavior', () => {
  it('renders loading, load failure, and empty states through the real drawer component', () => {
    expect(renderTrace({ loading: true })).toContain('Loading the latest run');
    expect(renderTrace({ failedToLoad: true })).toContain('run record could not be loaded');
    expect(renderTrace({ trace: null })).toContain('No model run yet');
  });

  it('localizes internal stage, status, tool, and failure enums in English and Chinese', () => {
    const english = renderTrace();
    const chinese = renderTrace({ locale: 'zh' });

    expect(english).toContain('Team composition');
    expect(english).toContain('Failed');
    expect(english).toContain('Query team knowledge');
    expect(english).toContain('Completed');
    expect(english).toContain('Provider error');
    expect(english).not.toContain('PROVIDER_ERROR');
    expect(english).not.toContain('Business tool');
    expect(chinese).toContain('队伍构成');
    expect(chinese).toContain('失败');
    expect(chinese).toContain('查询配队知识');
    expect(chinese).toContain('已完成');
    expect(chinese).toContain('模型服务错误');
    expect(chinese).not.toContain('业务工具');
  });
});
