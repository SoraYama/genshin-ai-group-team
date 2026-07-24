import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAgentSdkOptions,
  createResearchToolGate,
  resolvePackagedClaudeExecutable
} from '../../../src/main/services/agent-sdk-adapter.js';

const RESEARCH_QUERY = '原神 雷电将军 配队 攻略';

const preToolInput = (
  toolName: string,
  toolUseId: string,
  toolInput: Record<string, unknown> = {}
) =>
  ({
    hook_event_name: 'PreToolUse',
    session_id: 'session',
    transcript_path: '/tmp/transcript',
    cwd: '/tmp/genshin-advisor',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId
  }) as const;

describe('buildAgentSdkOptions', () => {
  it('pins a default-deny, tool-free, ephemeral SDK boundary', async () => {
    const abortController = new AbortController();
    const options = buildAgentSdkOptions({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.test',
      model: 'test-model',
      clientVersion: '1.0.0-test',
      systemPrompt: 'system',
      cwd: '/tmp/genshin-advisor',
      abortController
    });

    expect(options).toMatchObject({
      model: 'test-model',
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 1
    });
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['Agent', 'Task', 'Bash', 'Read', 'Write', 'WebFetch', 'WebSearch'])
    );
    expect(options.pathToClaudeCodeExecutable).toBeUndefined();
    expect(options.executable).toBeUndefined();
    expect(options.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'test-key',
      ANTHROPIC_BASE_URL: 'https://llm.example.test',
      ANTHROPIC_MODEL: 'test-model',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'genshin-team-advisor/1.0.0-test',
      CLAUDE_CONFIG_DIR: '/tmp/genshin-advisor/agent-runtime'
    });

    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(hook).toBeDefined();
    if (!hook) return;
    const output = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp/genshin-advisor',
        tool_name: 'UnexpectedTool',
        tool_input: {},
        tool_use_id: 'tool-use'
      },
      'tool-use',
      { signal: abortController.signal }
    );
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny'
      }
    });
  });

  it('does not expose the shared denied-tool policy to caller mutation', () => {
    const input = {
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.test',
      model: 'test-model',
      systemPrompt: 'system',
      cwd: '/tmp/genshin-advisor',
      abortController: new AbortController()
    };
    const first = buildAgentSdkOptions(input);
    first.disallowedTools?.splice(0);

    const second = buildAgentSdkOptions(input);

    expect(second.disallowedTools).toEqual(
      expect.arrayContaining(['Agent', 'Task', 'Bash', 'Read', 'Write', 'WebFetch', 'WebSearch'])
    );
  });

  it('resolves and pins the unpacked platform binary in a packaged app', async () => {
    const resourcesPath = await mkdtemp(path.join(os.tmpdir(), 'gta-sdk-'));
    const executable = path.join(
      resourcesPath,
      'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    );
    try {
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, 'fixture');
      expect(resolvePackagedClaudeExecutable(resourcesPath, 'darwin', 'arm64')).toBe(executable);

      const options = buildAgentSdkOptions({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example.test',
        model: 'test-model',
        systemPrompt: 'system',
        cwd: '/tmp/genshin-advisor',
        abortController: new AbortController(),
        pathToClaudeCodeExecutable: executable
      });
      expect(options.pathToClaudeCodeExecutable).toBe(executable);
    } finally {
      await rm(resourcesPath, { recursive: true, force: true });
    }
  });

  it('passes custom headers accepted by the shared validator', () => {
    const options = buildAgentSdkOptions({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.test',
      model: 'test-model',
      systemPrompt: 'system',
      cwd: '/tmp/genshin-advisor',
      abortController: new AbortController(),
      customHeaders: {
        'X-Tenant': 'community',
        'X_Test!': 'rfc-token'
      }
    });
    expect(options.env?.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Tenant: community\nX_Test!: rfc-token');
  });

  it.each([
    [{ 'Bad Header': 'value' }, 'invalid name'],
    [{ 'X-Nul': 'ok\u0000tail' }, 'NUL'],
    [{ 'X-Del': 'ok\u007ftail' }, 'DEL'],
    [{ 'X-Line': 'ok\u2028tail' }, 'Unicode line separator'],
    [{ 'X-Bidi': 'ok\u202etail' }, 'Unicode format control']
  ])('rejects %s at the generation boundary (%s)', (customHeaders, _label) => {
    expect(() =>
      buildAgentSdkOptions({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example.test',
        model: 'test-model',
        systemPrompt: 'system',
        cwd: '/tmp/genshin-advisor',
        abortController: new AbortController(),
        customHeaders
      })
    ).toThrow();
  });

  it('allows only explicitly registered read-only business MCP tools for bounded agent turns', async () => {
    const allowedBusinessTools = [
      'mcp__genshin__read_profile_cache',
      'mcp__genshin__query_enemy_data',
      'mcp__genshin__query_genshin_db'
    ];
    const options = buildAgentSdkOptions({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.test',
      model: 'test-model',
      systemPrompt: 'system',
      cwd: '/tmp/genshin-advisor',
      abortController: new AbortController(),
      maxTurns: 4,
      mcpServers: { genshin: { type: 'sdk', name: 'genshin', instance: {} as never } },
      allowedBusinessTools
    });

    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual(allowedBusinessTools);
    expect(options.mcpServers).toHaveProperty('genshin');
    expect(options.maxTurns).toBe(4);
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['Bash', 'Read', 'Write', 'WebFetch', 'WebSearch', 'Agent', 'Task'])
    );

    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('Expected permission hook');
    const allowed = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp/genshin-advisor',
        tool_name: 'mcp__genshin__query_enemy_data',
        tool_input: {},
        tool_use_id: 'allowed'
      },
      'allowed',
      { signal: new AbortController().signal }
    );
    expect(allowed).toEqual({ continue: true });

    const denied = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp/genshin-advisor',
        tool_name: 'mcp__other__read_profile_cache',
        tool_input: {},
        tool_use_id: 'denied'
      },
      'denied',
      { signal: new AbortController().signal }
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' }
    });
  });

  it('allows WebSearch only for the exact purpose-scoped research policy', async () => {
    const options = buildAgentSdkOptions({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.test',
      model: 'test-model',
      systemPrompt: 'system',
      cwd: '/tmp/genshin-advisor',
      abortController: new AbortController(),
      nativeToolPolicy: {
        purpose: 'research',
        allowed: ['WebSearch'],
        maxSearches: 3
      },
      researchAllowedQueries: [RESEARCH_QUERY]
    });

    expect(options.allowedTools).toEqual(['WebSearch']);
    expect(options.tools).toEqual(['WebSearch']);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['Agent', 'Task', 'Bash', 'Read', 'Write', 'Edit', 'WebFetch'])
    );
    expect(options.disallowedTools).not.toContain('WebSearch');
    expect(options.mcpServers).toBeUndefined();

    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('Expected research permission hook');
    const allowed = await hook(
      preToolInput('WebSearch', 'search-1', { query: RESEARCH_QUERY }),
      'search-1',
      { signal: new AbortController().signal }
    );
    expect(allowed).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
      }
    });
  });

  it('denies the fourth WebSearch call with the stable budget reason', async () => {
    const gate = createResearchToolGate({
      maxSearches: 3,
      allowedQueries: [RESEARCH_QUERY]
    });
    const signal = new AbortController().signal;

    for (const attempt of [1, 2, 3]) {
      await expect(
        gate(
          preToolInput('WebSearch', `search-${attempt}`, {
            query: RESEARCH_QUERY
          }),
          `search-${attempt}`,
          { signal }
        )
      ).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: 'allow' }
      });
    }
    await expect(
      gate(preToolInput('WebSearch', 'search-4', { query: RESEARCH_QUERY }), 'search-4', {
        signal
      })
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'SEARCH_BUDGET_EXCEEDED'
      }
    });
  });

  it.each([
    [{ query: '原神 雷电将军 配队 攻略 UID 123456789' }, 'UID'],
    [{ query: '原神攻略 cookie ltoken_v2=secret' }, 'Cookie'],
    [{ query: '原神攻略 Authorization Bearer secret' }, 'Authorization'],
    [{ query: '原神攻略 api_key sk-secret' }, 'API key'],
    [{ query: '原神攻略 critRate 88.8' }, 'panel attribute'],
    [{ query: '原神攻略 U%2549D%253A123456789' }, 'repeatedly encoded UID'],
    [{ query: '原神攻略 x123456789x' }, 'UID digits adjacent to letters'],
    [{ query: '原神攻略 ١٢٣٤٥٦٧٨٩' }, 'Arabic-Indic UID digits'],
    [{ query: '原神攻略 ۱۲۳۴۵۶۷۸۹' }, 'Extended Arabic-Indic UID digits'],
    [{ query: '原神攻略 ١٢٣٤\u200b٥٦٧٨٩' }, 'Unicode UID digits split by zero-width text'],
    [
      {
        query:
          '原神攻略 %25D9%25A1%25D9%25A2%25D9%25A3%25D9%25A4%25D9%25A5%25D9%25A6%25D9%25A7%25D9%25A8%25D9%25A9'
      },
      'repeatedly encoded Arabic-Indic UID digits'
    ],
    [{ query: '原神攻略', extra: 'not-supported' }, 'unexpected input field']
  ])('rejects a WebSearch input containing %s (%s)', async (toolInput, _label) => {
    const gate = createResearchToolGate({
      maxSearches: 3,
      allowedQueries: [RESEARCH_QUERY]
    });
    const input = {
      ...preToolInput('WebSearch', 'unsafe-search'),
      tool_input: toolInput
    };

    await expect(
      gate(input, 'unsafe-search', { signal: new AbortController().signal })
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'SEARCH_QUERY_REJECTED'
      }
    });
  });

  it('allows canonical research terms and a bounded non-UID article number', async () => {
    const query =
      '原神 雷电将军 electro polearm single-target build-match-present article-20240725';
    const gate = createResearchToolGate({
      maxSearches: 3,
      allowedQueries: [query]
    });

    await expect(
      gate(
        preToolInput('WebSearch', 'safe-search', {
          query
        }),
        'safe-search',
        { signal: new AbortController().signal }
      )
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'allow'
      }
    });
  });

  it('rejects a privacy-safe query that was not generated for this research run', async () => {
    const gate = createResearchToolGate({
      maxSearches: 3,
      allowedQueries: [RESEARCH_QUERY]
    });

    await expect(
      gate(
        preToolInput('WebSearch', 'outside-allowlist', {
          query: '原神 纳西妲 配队 攻略'
        }),
        'outside-allowlist',
        { signal: new AbortController().signal }
      )
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'SEARCH_QUERY_REJECTED'
      }
    });
  });

  it('counts malformed and rejected unique WebSearch attempts against the budget', async () => {
    const gate = createResearchToolGate({
      maxSearches: 3,
      allowedQueries: [RESEARCH_QUERY]
    });
    const signal = new AbortController().signal;

    for (const [id, toolInput] of [
      ['malformed-1', {}],
      ['sensitive-2', { query: 'UID 123456789' }],
      ['outside-3', { query: '原神 纳西妲 配队 攻略' }]
    ] as const) {
      await expect(
        gate(preToolInput('WebSearch', id, toolInput), id, { signal })
      ).resolves.toMatchObject({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: 'SEARCH_QUERY_REJECTED'
        }
      });
    }

    await expect(
      gate(
        preToolInput('WebSearch', 'valid-but-fourth', { query: RESEARCH_QUERY }),
        'valid-but-fourth',
        { signal }
      )
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'SEARCH_BUDGET_EXCEEDED'
      }
    });
  });

  it('returns the cached decision for a valid tool-use ID replay without consuming budget', async () => {
    const gate = createResearchToolGate({
      maxSearches: 3,
      allowedQueries: [RESEARCH_QUERY]
    });
    const signal = new AbortController().signal;
    const first = await gate(
      preToolInput('WebSearch', 'replayed-search', { query: RESEARCH_QUERY }),
      'replayed-search',
      { signal }
    );
    const replay = await gate(
      preToolInput('WebSearch', 'replayed-search', { query: '原神 纳西妲 配队 攻略' }),
      'replayed-search',
      { signal }
    );

    expect(replay).toEqual(first);
    for (const id of ['search-2', 'search-3']) {
      await expect(
        gate(preToolInput('WebSearch', id, { query: RESEARCH_QUERY }), id, { signal })
      ).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: 'allow' }
      });
    }
    await expect(
      gate(preToolInput('WebSearch', 'search-4', { query: RESEARCH_QUERY }), 'search-4', {
        signal
      })
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'SEARCH_BUDGET_EXCEEDED'
      }
    });
  });

  it('fails closed and consumes attempts for missing or invalid tool-use IDs without replay caching', async () => {
    const gate = createResearchToolGate({
      maxSearches: 3,
      allowedQueries: [RESEARCH_QUERY]
    });
    const signal = new AbortController().signal;
    const invalidRequests = [
      {
        ...preToolInput('WebSearch', 'placeholder', { query: RESEARCH_QUERY }),
        tool_use_id: undefined
      },
      preToolInput('WebSearch', 'invalid id', { query: RESEARCH_QUERY }),
      preToolInput('WebSearch', 'invalid id', { query: RESEARCH_QUERY })
    ];

    for (const request of invalidRequests) {
      await expect(
        gate(request as Parameters<typeof gate>[0], 'callback-id', { signal })
      ).resolves.toMatchObject({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: 'SEARCH_QUERY_REJECTED'
        }
      });
    }
    await expect(
      gate(preToolInput('WebSearch', 'valid-fourth', { query: RESEARCH_QUERY }), 'valid-fourth', {
        signal
      })
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'SEARCH_BUDGET_EXCEEDED'
      }
    });
  });

  it('copies the generated query allowlist when SDK options are built', async () => {
    const researchAllowedQueries = [RESEARCH_QUERY];
    const options = buildAgentSdkOptions({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.test',
      model: 'test-model',
      systemPrompt: 'system',
      cwd: '/tmp/genshin-advisor',
      abortController: new AbortController(),
      nativeToolPolicy: {
        purpose: 'research',
        allowed: ['WebSearch'],
        maxSearches: 3
      },
      researchAllowedQueries
    });
    researchAllowedQueries[0] = '原神 纳西妲 配队 攻略';

    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('Expected research permission hook');
    await expect(
      hook(
        preToolInput('WebSearch', 'immutable-query', { query: RESEARCH_QUERY }),
        'immutable-query',
        { signal: new AbortController().signal }
      )
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' }
    });
  });

  it('fails closed for mutated research policies and business-tool combinations', () => {
    const base = {
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.test',
      model: 'test-model',
      systemPrompt: 'system',
      cwd: '/tmp/genshin-advisor',
      abortController: new AbortController()
    };
    const mutatedPolicies: unknown[] = [
      { purpose: 'compose', allowed: ['WebSearch'], maxSearches: 3 },
      { purpose: 'research', allowed: ['WebSearch', 'WebFetch'], maxSearches: 3 },
      { purpose: 'research', allowed: ['WebSearch'], maxSearches: 4 },
      { purpose: 'research', allowed: ['WebSearch'], maxSearches: 3, extra: true }
    ];

    for (const nativeToolPolicy of mutatedPolicies) {
      expect(() =>
        buildAgentSdkOptions({
          ...base,
          nativeToolPolicy,
          researchAllowedQueries: [RESEARCH_QUERY]
        } as Parameters<typeof buildAgentSdkOptions>[0])
      ).toThrow();
    }

    expect(() =>
      buildAgentSdkOptions({
        ...base,
        nativeToolPolicy: {
          purpose: 'research',
          allowed: ['WebSearch'],
          maxSearches: 3
        },
        researchAllowedQueries: [RESEARCH_QUERY],
        allowedBusinessTools: ['mcp__genshin__query_genshin_db']
      })
    ).toThrow();
    expect(() =>
      buildAgentSdkOptions({
        ...base,
        nativeToolPolicy: {
          purpose: 'research',
          allowed: ['WebSearch'],
          maxSearches: 3
        },
        researchAllowedQueries: [RESEARCH_QUERY],
        mcpServers: { genshin: { type: 'sdk', name: 'genshin', instance: {} as never } }
      })
    ).toThrow();
  });

  it('requires a bounded safe query allowlist exactly for research runs', () => {
    const base = {
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.test',
      model: 'test-model',
      systemPrompt: 'system',
      cwd: '/tmp/genshin-advisor',
      abortController: new AbortController()
    };
    expect(() =>
      buildAgentSdkOptions({
        ...base,
        nativeToolPolicy: {
          purpose: 'research',
          allowed: ['WebSearch'],
          maxSearches: 3
        }
      })
    ).toThrow();
    expect(() =>
      buildAgentSdkOptions({
        ...base,
        researchAllowedQueries: [RESEARCH_QUERY]
      })
    ).toThrow();
    for (const researchAllowedQueries of [
      [],
      [RESEARCH_QUERY, RESEARCH_QUERY],
      [RESEARCH_QUERY, 'UID 123456789'],
      [RESEARCH_QUERY, '原神 纳西妲 配队', '原神 深渊 配队', '原神 Boss 配队']
    ]) {
      expect(() =>
        buildAgentSdkOptions({
          ...base,
          nativeToolPolicy: {
            purpose: 'research',
            allowed: ['WebSearch'],
            maxSearches: 3
          },
          researchAllowedQueries
        })
      ).toThrow();
    }
  });
});
