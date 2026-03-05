import type { AppConfig } from '../config.js';

export type CheckStatus = 'up' | 'down' | 'skipped';

export interface CheckResult {
  name: 'genshinDb' | 'enemyData' | 'llm' | 'miyoushe';
  status: CheckStatus;
  latencyMs: number;
  httpStatus?: number;
  message?: string;
}

export interface HealthCheckOptions {
  config: AppConfig;
  fetchImpl?: typeof fetch;
  miyousheCookie?: string;
}

interface RawResponse {
  status: number;
  json: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
): Promise<RawResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    const json = (await response.json()) as unknown;
    return { status: response.status, json };
  } finally {
    clearTimeout(timeout);
  }
}

function buildCheckResult(
  name: CheckResult['name'],
  startTime: number,
  status: CheckStatus,
  extras?: Partial<CheckResult>
): CheckResult {
  return {
    name,
    status,
    latencyMs: Date.now() - startTime,
    ...extras
  };
}

async function checkGenshinDb(fetchImpl: typeof fetch, config: AppConfig): Promise<CheckResult> {
  const start = Date.now();

  const validateShape = (json: unknown): boolean => {
    return (Array.isArray(json) && json.length > 0) || (isObject(json) && typeof json.name === 'string');
  };

  try {
    const response = await fetchJsonWithTimeout(fetchImpl, config.genshinDbUrl, config.requestTimeoutMs);
    if (!validateShape(response.json)) {
      return buildCheckResult('genshinDb', start, 'down', {
        httpStatus: response.status,
        message: 'Unexpected response shape from genshin-db source'
      });
    }

    return buildCheckResult('genshinDb', start, response.status >= 200 && response.status < 300 ? 'up' : 'down', {
      httpStatus: response.status
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      try {
        const fallbackResponse = await fetchJsonWithTimeout(
          fetchImpl,
          'https://genshin.jmp.blue/characters/albedo',
          config.requestTimeoutMs + 3000
        );

        if (validateShape(fallbackResponse.json) && fallbackResponse.status >= 200 && fallbackResponse.status < 300) {
          return buildCheckResult('genshinDb', start, 'up', {
            httpStatus: fallbackResponse.status,
            message: 'Primary endpoint timed out; fallback endpoint succeeded'
          });
        }
      } catch {
      }
    }

    return buildCheckResult('genshinDb', start, 'down', {
      message: error instanceof Error ? error.message : 'Unknown genshin-db error'
    });
  }
}

async function checkEnemyData(fetchImpl: typeof fetch, config: AppConfig): Promise<CheckResult> {
  const start = Date.now();

  const validateShape = (json: unknown): boolean => {
    return (
      (Array.isArray(json) && json.length > 0) ||
      (isObject(json) && ('data' in json || 'retcode' in json || 'name' in json || 'id' in json))
    );
  };

  try {
    const response = await fetchJsonWithTimeout(fetchImpl, config.enemyDataUrl, config.requestTimeoutMs);
    if (!validateShape(response.json)) {
      return buildCheckResult('enemyData', start, 'down', {
        httpStatus: response.status,
        message: 'Unexpected response shape from enemy data source'
      });
    }

    return buildCheckResult('enemyData', start, response.status >= 200 && response.status < 300 ? 'up' : 'down', {
      httpStatus: response.status
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const fallbackUrls = [
        config.enemyDataUrl,
        config.enemyDataUrl.endsWith('/enemies') ? `${config.enemyDataUrl}/abyss-mage` : config.enemyDataUrl,
        'https://genshin.jmp.blue/enemies/abyss-mage'
      ];

      for (const fallbackUrl of fallbackUrls) {
        try {
          const fallbackResponse = await fetchJsonWithTimeout(
            fetchImpl,
            fallbackUrl,
            config.requestTimeoutMs + 6000
          );

          if (validateShape(fallbackResponse.json) && fallbackResponse.status >= 200 && fallbackResponse.status < 300) {
            return buildCheckResult('enemyData', start, 'up', {
              httpStatus: fallbackResponse.status,
              message: 'Primary endpoint timed out; fallback endpoint succeeded'
            });
          }
        } catch {
          continue;
        }
      }

      return buildCheckResult('enemyData', start, 'down', {
        message: error.message
      });
    }

    return buildCheckResult('enemyData', start, 'down', {
      message: error instanceof Error ? error.message : 'Unknown enemy data source error'
    });
  }
}

async function checkLlm(fetchImpl: typeof fetch, config: AppConfig): Promise<CheckResult> {
  const start = Date.now();

  if (!config.llmApiKey || !config.llmHealthUrl) {
    return buildCheckResult('llm', start, 'skipped', {
      message: 'Set ZHIPU_API_KEY (or ZAI_API_KEY) to enable LLM health checks'
    });
  }

  try {
    const response = await fetchJsonWithTimeout(fetchImpl, config.llmHealthUrl, config.requestTimeoutMs, {
      Authorization: `Bearer ${config.llmApiKey}`
    });

    const providerText = config.llmProvider === 'zhipu' ? 'Zhipu LLM' : 'LLM';
    return buildCheckResult('llm', start, response.status >= 200 && response.status < 300 ? 'up' : 'down', {
      httpStatus: response.status,
      message: response.status >= 200 && response.status < 300 ? undefined : `${providerText} endpoint returned non-2xx status`
    });
  } catch (error) {
    return buildCheckResult('llm', start, 'down', {
      message: error instanceof Error ? error.message : 'Unknown LLM health check error'
    });
  }
}

async function checkMiyoushe(
  fetchImpl: typeof fetch,
  config: AppConfig,
  cookie?: string
): Promise<CheckResult> {
  const start = Date.now();

  if (!cookie) {
    return buildCheckResult('miyoushe', start, 'skipped', {
      message: 'Miyoushe cookie not provided'
    });
  }

  try {
    const response = await fetchJsonWithTimeout(fetchImpl, config.miyousheRoleUrl, config.requestTimeoutMs, {
      Cookie: cookie
    });
    const json = response.json;

    if (!isObject(json) || typeof json.retcode !== 'number') {
      return buildCheckResult('miyoushe', start, 'down', {
        httpStatus: response.status,
        message: 'Unexpected Miyoushe response shape'
      });
    }

    const status = response.status >= 200 && response.status < 300 && json.retcode === 0 ? 'up' : 'down';

    return buildCheckResult('miyoushe', start, status, {
      httpStatus: response.status,
      message: status === 'up' ? undefined : `Miyoushe retcode=${String(json.retcode)}`
    });
  } catch (error) {
    return buildCheckResult('miyoushe', start, 'down', {
      message: error instanceof Error ? error.message : 'Unknown Miyoushe health check error'
    });
  }
}

export async function runExternalChecks(options: HealthCheckOptions): Promise<CheckResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const checks = await Promise.all([
    checkGenshinDb(fetchImpl, options.config),
    checkEnemyData(fetchImpl, options.config),
    checkLlm(fetchImpl, options.config),
    checkMiyoushe(fetchImpl, options.config, options.miyousheCookie)
  ]);

  return checks;
}

export function requiredCheckNames(config: AppConfig, includeMiyoushe: boolean): Array<CheckResult['name']> {
  const required: Array<CheckResult['name']> = ['genshinDb', 'enemyData'];

  if (config.llmApiKey && config.llmHealthUrl) {
    required.push('llm');
  }

  if (includeMiyoushe) {
    required.push('miyoushe');
  }

  return required;
}
