import { describe, expect, it, vi } from 'vitest';
import type { CharacterProfile } from '../../../src/shared/domain.js';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '0.1.0-test',
    getPath: () => '/tmp/genshin-team-advisor-test'
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc::${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc::/, '')
  }
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw new Error('SDK should not be invoked in fallback tests');
  }
}));

const SAMPLE_CHARACTERS: CharacterProfile[] = [
  { id: 1, name: 'Hutao', element: 'Pyro', rarity: 5, imageUrl: '', stats: { level: 90, hp: 35000, atk: 2200, def: 800, critRate: 75, critDmg: 230, energyRecharge: 120, elementalMastery: 120 } },
  { id: 2, name: 'Yelan', element: 'Hydro', rarity: 5, imageUrl: '', stats: { level: 90, hp: 41000, atk: 1500, def: 780, critRate: 70, critDmg: 210, energyRecharge: 180, elementalMastery: 80 } },
  { id: 3, name: 'Zhongli', element: 'Geo', rarity: 5, imageUrl: '', stats: { level: 90, hp: 48000, atk: 1300, def: 1000, critRate: 55, critDmg: 150, energyRecharge: 130, elementalMastery: 40 } },
  { id: 4, name: 'Xingqiu', element: 'Hydro', rarity: 4, imageUrl: '', stats: { level: 90, hp: 21000, atk: 1650, def: 780, critRate: 55, critDmg: 150, energyRecharge: 230, elementalMastery: 60 } },
  { id: 5, name: 'Bennett', element: 'Pyro', rarity: 4, imageUrl: '', stats: { level: 80, hp: 14000, atk: 1100, def: 700, critRate: 12, critDmg: 50, energyRecharge: 220, elementalMastery: 40 } }
];

describe('extractJsonPayload', () => {
  it('parses plain JSON', async () => {
    const { extractJsonPayload } = await import('../../../src/main/services/advisor-agent.js');
    const result = extractJsonPayload('{"summary":"ok","teams":[{"characterIds":[1,2,3,4]}]}');
    expect(result?.summary).toBe('ok');
    expect(result?.teams?.[0]?.characterIds).toEqual([1, 2, 3, 4]);
  });

  it('extracts JSON wrapped in ``` fence', async () => {
    const { extractJsonPayload } = await import('../../../src/main/services/advisor-agent.js');
    const raw = '思考完毕。\n```json\n{"summary":"fenced","teams":[]}\n```\n';
    const result = extractJsonPayload(raw);
    expect(result?.summary).toBe('fenced');
  });

  it('extracts JSON when buried in narrative text', async () => {
    const { extractJsonPayload } = await import('../../../src/main/services/advisor-agent.js');
    const raw = '这是分析：{"summary":"buried","teams":[{"characterIds":[1,2,3,4]}]} 完。';
    const result = extractJsonPayload(raw);
    expect(result?.summary).toBe('buried');
  });

  it('returns undefined on totally invalid input', async () => {
    const { extractJsonPayload } = await import('../../../src/main/services/advisor-agent.js');
    expect(extractJsonPayload('not json at all')).toBeUndefined();
  });
});

describe('normalizeLlmResult', () => {
  it('keeps only teams with 4 known character ids', async () => {
    const { normalizeLlmResult } = await import('../../../src/main/services/advisor-agent.js');
    const result = normalizeLlmResult(
      {
        summary: 'pick',
        teams: [
          { name: '蒸发主C', characterIds: [1, 2, 4, 3], reasoning: 'ok', rotationTip: 'r' },
          { name: '不完整', characterIds: [1, 2, 999] },
          { name: '满', characterIds: [1, 2, 3, 4, 5] }
        ]
      },
      SAMPLE_CHARACTERS
    );

    expect(result.source).toBe('llm');
    expect(result.teams).toHaveLength(2);
    expect(result.teams[0]?.name).toBe('蒸发主C');
    expect(result.teams[0]?.characters.map((c) => c.id)).toEqual([1, 2, 4, 3]);
    expect(result.teams[1]?.characters).toHaveLength(4);
  });

  it('defaults reasoning/rotationTip when LLM omits them', async () => {
    const { normalizeLlmResult } = await import('../../../src/main/services/advisor-agent.js');
    const result = normalizeLlmResult(
      { teams: [{ characterIds: [1, 2, 3, 4] }] },
      SAMPLE_CHARACTERS
    );
    expect(result.teams[0]?.reasoning).toContain('角色面板');
    expect(result.teams[0]?.rotationTip).toContain('元素');
  });
});

describe('buildFallback', () => {
  it('picks the 4 highest-scoring characters', async () => {
    const { buildFallback } = await import('../../../src/main/services/advisor-agent.js');
    const result = buildFallback(SAMPLE_CHARACTERS, ['abyss-mage']);

    expect(result.source).toBe('fallback');
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]?.characters).toHaveLength(4);
    expect(result.summary).toContain('abyss-mage');
  });

  it('handles empty enemy list with a sensible summary', async () => {
    const { buildFallback } = await import('../../../src/main/services/advisor-agent.js');
    const result = buildFallback(SAMPLE_CHARACTERS, []);
    expect(result.summary).toContain('未提供敌人');
  });
});
