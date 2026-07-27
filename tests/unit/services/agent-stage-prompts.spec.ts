import { describe, expect, it } from 'vitest';

import {
  CRITIQUE_PROMPT_V2,
  CRITIQUE_PROMPT_V3
} from '../../../src/main/agents/critique/prompt.js';
import {
  EXPLAIN_PROMPT_V2,
  EXPLAIN_PROMPT_V3
} from '../../../src/main/agents/explain/prompt.js';
import {
  ROTATION_COACH_PROMPT_V2,
  ROTATION_COACH_PROMPT_V3
} from '../../../src/main/agents/rotation-coach/prompt.js';

describe('strict-stage target contracts', () => {
  it('enumerates exact Critique target objects and keeps uncertainty non-fatal', () => {
    for (const prompt of [CRITIQUE_PROMPT_V2, CRITIQUE_PROMPT_V3]) {
      expect(prompt).toContain('{"kind":"abyss-team","half":"first|second"}');
      expect(prompt).toContain(
        '{"kind":"abyss-chamber","floor":12,"chamber":1,"half":"first|second"}'
      );
      expect(prompt).toContain('不得增加 characters、team、scope');
      expect(prompt).toContain('单纯知识未知');
      expect(prompt).toContain('已在 warnings 明确披露');
      expect(prompt).toContain('message 不超过 160 个汉字');
      expect(prompt).toContain('message 内不得出现半角双引号');
    }
    expect(CRITIQUE_PROMPT_V3).toContain('severity 字面量只能是 soft');
  });

  it('enumerates only the target variants accepted by Rotation and Explain', () => {
    for (const prompt of [ROTATION_COACH_PROMPT_V2, ROTATION_COACH_PROMPT_V3]) {
      expect(prompt).toContain('{"kind":"abyss-team","half":"first|second"}');
      expect(prompt).not.toContain('"kind":"abyss-chamber"');
    }
    for (const prompt of [EXPLAIN_PROMPT_V2, EXPLAIN_PROMPT_V3]) {
      expect(prompt).toContain(
        '{"kind":"abyss-chamber","floor":12,"chamber":1,"half":"first|second"}'
      );
      expect(prompt).not.toContain('"kind":"abyss-team"');
    }
  });

  it('gives Explain an exact reason-to-fact mapping and a bounded unknown-only fallback', () => {
    expect(EXPLAIN_PROMPT_V3).toContain(
      'mechanic-response / target-priority 只能引用 kind=mechanic'
    );
    expect(EXPLAIN_PROMPT_V3).toContain(
      '只有 plan:validated-target 可引用时，只能输出 reasonCodes=["uncertainty"]'
    );
  });

  it('separates uncertainty from tone and requires exact target coverage', () => {
    for (const prompt of [ROTATION_COACH_PROMPT_V3, EXPLAIN_PROMPT_V3]) {
      expect(prompt).toContain('uncertainty 是 reasonCode，不是 tone');
      expect(prompt).toContain('全部目标且每个目标恰好一次');
      expect(prompt).toContain(
        'kind=knowledge 必须严格写成 {"kind":"knowledge","characterId":"角色ID"}，不得使用 field'
      );
    }
  });

  it('requires mechanic fact references to copy the bounded context target string', () => {
    for (const prompt of [ROTATION_COACH_PROMPT_V3, EXPLAIN_PROMPT_V3]) {
      expect(prompt).toContain(
        '{"kind":"mechanic","target":"逐字复制 context.mechanics[].target","factIndex":0}'
      );
      expect(prompt).toContain('mechanic 的 target 不得使用外层 target 对象');
    }
  });
});
