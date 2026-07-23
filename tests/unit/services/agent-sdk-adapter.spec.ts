import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAgentSdkOptions,
  resolvePackagedClaudeExecutable
} from '../../../src/main/services/agent-sdk-adapter.js';

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
      expect.arrayContaining(['Agent', 'Task', 'Bash', 'Read', 'Write', 'WebFetch'])
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
      expect.arrayContaining(['Bash', 'Read', 'Write', 'WebFetch', 'Agent', 'Task'])
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
});
