import { describe, expect, it } from 'vitest';

import { parseAgentJson } from '../../../src/main/services/agent-json.js';

describe('parseAgentJson', () => {
  it('parses a strict JSON value', () => {
    expect(parseAgentJson('{"ok":true}')).toEqual({ ok: true });
  });

  it('accepts one exact json code fence without surrounding prose', () => {
    expect(parseAgentJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('repairs only clearly unescaped prose quotes inside an otherwise canonical JSON string', () => {
    expect(
      parseAgentJson(
        '```json\n{"message":"计划声称"保证循环"但缺少事实","decision":"repair"}\n```'
      )
    ).toEqual({
      message: '计划声称"保证循环"但缺少事实',
      decision: 'repair'
    });
  });

  it('does not reinterpret structural quotes or arbitrary non-JSON prose', () => {
    expect(parseAgentJson('{"message":"broken","extra":"still broken}')).toBeUndefined();
    expect(parseAgentJson('prefix {"message":"quoted"value"}')).toBeUndefined();
  });

  it.each([
    'Result:\n```json\n{"ok":true}\n```',
    '```json\n{"ok":true}\n```\nextra',
    '```\n{"ok":true}\n```',
    '```json\n{"ok":true}'
  ])('rejects non-canonical wrapped output: %s', (value) => {
    expect(parseAgentJson(value)).toBeUndefined();
  });
});
