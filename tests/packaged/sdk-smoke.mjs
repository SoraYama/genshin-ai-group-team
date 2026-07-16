import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const releaseDir = process.env.GTA_RELEASE_DIR ?? 'release';
const executableCandidates = process.env.GTA_PACKAGED_APP_PATH
  ? [process.env.GTA_PACKAGED_APP_PATH]
  :
  process.platform === 'win32'
    ? [
        path.join(releaseDir, 'win-unpacked/Genshin Team Advisor.exe'),
        path.join(releaseDir, 'win-arm64-unpacked/Genshin Team Advisor.exe')
      ]
    : [
        path.join(
          releaseDir,
          'mac-universal/Genshin Team Advisor.app/Contents/MacOS/Genshin Team Advisor'
        ),
        path.join(
          releaseDir,
          'mac-arm64/Genshin Team Advisor.app/Contents/MacOS/Genshin Team Advisor'
        ),
        path.join(releaseDir, 'mac/Genshin Team Advisor.app/Contents/MacOS/Genshin Team Advisor')
      ];
const executable = executableCandidates
  .map((candidate) => path.resolve(candidate))
  .find(existsSync);
if (!executable) throw new Error('Packaged application not found; run npm run pack:dir first');

const stageOutputs = [
  { usableCharacterIds: [1, 2, 3, 4], partial: true, dataNotes: ['packaged smoke'] },
  {
    teams: [
      {
        name: 'Packaged Smoke',
        characterIds: [1, 2, 3, 4],
        concept: 'protocol smoke',
        confidence: 'low',
        assumptions: ['fixture']
      }
    ]
  },
  { reviews: [{ teamIndex: 0, viable: true, issues: [] }] },
  { rotations: [{ teamIndex: 0, rotationTip: 'fixture rotation' }] },
  {
    summary: '基于部分数据的 packaged smoke。',
    teams: [{ teamIndex: 0, reasoning: 'fixture reasoning' }]
  }
];
const stageMarkers = [
  'DataCuratorAgent',
  'TeamComposerAgent',
  'CritiqueAgent',
  'RotationCoachAgent',
  'ExplainAgent'
];
let requestCount = 0;
const requestRoutes = [];
const observedStages = new Set();

const server = http.createServer(async (request, response) => {
  requestRoutes.push(`${request.method ?? 'UNKNOWN'} ${request.url?.split('?')[0] ?? '/'}`);
  if (request.method === 'HEAD') {
    response.writeHead(200);
    response.end();
    return;
  }
  let requestBody = '';
  for await (const chunk of request) requestBody += String(chunk);
  let systemText = '';
  try {
    const parsed = JSON.parse(requestBody);
    systemText = JSON.stringify(parsed.system ?? '');
  } catch {
    // The mock returns a typed failure below; raw request data is never logged.
  }
  requestBody = '';
  const stageIndex = stageMarkers.findIndex((marker) => systemText.includes(marker));
  systemText = '';
  const stageOutput = stageOutputs[stageIndex];
  requestCount += 1;
  if (!stageOutput) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"error":"unexpected extra request"}');
    return;
  }
  observedStages.add(stageIndex);
  const responseText = JSON.stringify(stageOutput);
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache'
  });
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_packaged_smoke_${requestCount}`,
          type: 'message',
          role: 'assistant',
          model: 'smoke-model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 }
        }
      }
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      }
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: responseText }
      }
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 }
      }
    ],
    ['message_stop', { type: 'message_stop' }]
  ];
  for (const [event, data] of events) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  response.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to bind mock provider');

const child = spawn(executable, [], {
  env: {
    ...process.env,
    GTA_PACKAGED_SDK_SMOKE_URL: `http://127.0.0.1:${address.port}`,
    GTA_E2E_USER_DATA_DIR: path.resolve('.tmp/gta-packaged-sdk-smoke'),
    GTA_DISABLE_BACKGROUND_REFRESH: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += String(chunk);
});
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

const exitCode = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(
      new Error(
        `Packaged SDK smoke timed out (requests=${requestCount}, stages=${[...observedStages].join(',')})\n` +
          `routes=${requestRoutes.join(',')}\nstdout=${stdout.slice(-1000)}\nstderr=${stderr.slice(-1000)}`
      )
    );
  }, 90_000);
  child.once('error', reject);
  child.once('exit', (code) => {
    clearTimeout(timer);
    resolve(code);
  });
}).finally(() => server.close());

const passed =
  exitCode === 0 &&
  observedStages.size === stageOutputs.length &&
  stdout.includes('"gate":"packaged-sdk","status":"passed"');
if (!passed) {
  throw new Error(
    `Packaged SDK smoke failed (exit=${exitCode}, requests=${requestCount})\nroutes=${requestRoutes.join(',')}\nstdout=${stdout.slice(-1000)}\nstderr=${stderr.slice(-1000)}`
  );
}
console.log(JSON.stringify({ gate: 'packaged-sdk', status: 'passed' }));
