import { describe, expect, it } from 'vitest';

import {
  parseAgentJson,
  parseAgentJsonWithKnownStringArrays,
  parseStructurallyIncompleteAgentJson
} from '../../../src/main/services/agent-json.js';

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

  it('repairs only bounded missing structural closers in an otherwise strict JSON value', () => {
    expect(
      parseStructurallyIncompleteAgentJson(
        '{"chambers":[{"secondHalf":{"risks":[]}]}'
      )
    ).toEqual({
      chambers: [{ secondHalf: { risks: [] } }]
    });
  });

  it('repairs a missing opening bracket only for an explicitly known string-array field', () => {
    const raw =
      '{"firstHalf":{"tactics":["保持循环"],"risks":[]},"secondHalf":{"tactics":"保留关键技能"],"risks":["秒杀风险"]}}';

    expect(
      parseAgentJsonWithKnownStringArrays(raw, [
        'tactics',
        'risks',
        'substitutionNotes'
      ])
    ).toEqual({
      firstHalf: { tactics: ['保持循环'], risks: [] },
      secondHalf: { tactics: ['保留关键技能'], risks: ['秒杀风险'] }
    });
    expect(parseAgentJsonWithKnownStringArrays(raw, ['risks'])).toBeUndefined();
  });

  it.each([
    'prefix {"chambers":[{"secondHalf":{"risks":[]}]}',
    '{"left":1 "right":2}',
    '{"message":"unterminated}',
    `{"nested":${'['.repeat(9)}0}`
  ])('does not repair prose, token errors, strings, or excessive damage: %s', (value) => {
    expect(parseStructurallyIncompleteAgentJson(value)).toBeUndefined();
  });
});
