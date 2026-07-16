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

  it('passes compatible custom headers without allowing newline injection', () => {
    const options = buildAgentSdkOptions({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.test',
      model: 'test-model',
      systemPrompt: 'system',
      cwd: '/tmp/genshin-advisor',
      abortController: new AbortController(),
      customHeaders: {
        'X-Tenant': 'community',
        'Bad Header': 'ignored',
        'X-Injected': 'ok\nAuthorization: leaked'
      }
    });
    expect(options.env?.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Tenant: community');
  });
});
