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
});
