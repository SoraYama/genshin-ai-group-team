import { readConfig } from '../src/config.js';
import { requiredCheckNames, runExternalChecks } from '../src/services/external-health.js';

async function runGate(): Promise<void> {
  const config = readConfig();
  const miyousheCookie = process.env.MYS_COOKIE;
  const includeMiyoushe = Boolean(miyousheCookie);

  const checks = await runExternalChecks({
    config,
    miyousheCookie
  });

  const required = requiredCheckNames(config, includeMiyoushe);
  const failedRequired = checks.filter((check) => required.includes(check.name) && check.status !== 'up');

  for (const check of checks) {
    const status = check.status.toUpperCase();
    const extra = check.message ? ` (${check.message})` : '';
    process.stdout.write(`${check.name}: ${status} [${check.latencyMs}ms]${extra}\n`);
  }

  if (failedRequired.length > 0) {
    process.stderr.write(`External gate failed. Required checks down: ${failedRequired.map((v) => v.name).join(', ')}\n`);
    process.exit(1);
  }

  process.stdout.write('External API gate passed.\n');
}

void runGate();
