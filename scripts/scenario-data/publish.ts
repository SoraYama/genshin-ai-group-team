import { readFile } from 'node:fs/promises';

import { publishScenarioInputDirectory } from '../../src/main/scenario-publication/file-publisher.js';

function parseArguments(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || !value) {
      throw new Error('Expected --flag value arguments.');
    }
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

const args = parseArguments(process.argv.slice(2));
const required = ['input', 'output', 'private-key', 'key-id', 'published-at'] as const;
for (const key of required) {
  if (!args[key]) throw new Error(`Missing required argument: --${key}`);
}

const manifest = await publishScenarioInputDirectory({
  inputDirectory: args.input!,
  outputDirectory: args.output!,
  privateKey: await readFile(args['private-key']!, 'utf8'),
  keyId: args['key-id']!,
  publishedAt: args['published-at']!
});

process.stdout.write(
  `Published ${Object.values(manifest.modes).filter(({ current }) => current).length} current scenario samples to ${args.output}\n`
);
