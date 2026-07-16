import { request } from 'undici';

const apiKey = process.env.GTA_PROVIDER_API_KEY;
const baseUrl = process.env.GTA_PROVIDER_BASE_URL?.replace(/\/+$/, '');
const model = process.env.GTA_PROVIDER_MODEL;

if (!apiKey || !baseUrl || !model) {
  console.log(JSON.stringify({ gate: 'provider-contract', status: 'skipped', reason: 'missing-env' }));
  process.exit(0);
}

const startedAt = Date.now();
try {
  const response = await request(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }]
    }),
    bodyTimeout: 15_000,
    headersTimeout: 15_000
  });
  await response.body.dump();
  const passed = response.statusCode >= 200 && response.statusCode < 300;
  console.log(
    JSON.stringify({
      gate: 'provider-contract',
      status: passed ? 'passed' : 'failed',
      httpStatus: response.statusCode,
      latencyMs: Date.now() - startedAt
    })
  );
  process.exit(passed ? 0 : 1);
} catch (error) {
  console.error(
    JSON.stringify({
      gate: 'provider-contract',
      status: 'failed',
      error: error instanceof Error ? error.name : 'Error',
      latencyMs: Date.now() - startedAt
    })
  );
  process.exit(1);
}
