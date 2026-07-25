import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface TypeScriptConfig {
  extends?: string;
  compilerOptions: {
    lib?: string[];
    jsx?: string;
    types?: string[];
  };
  include?: string[];
  exclude?: string[];
}

describe('TypeScript environment boundaries', () => {
  it('keeps main and shared on a pure Node library surface', async () => {
    const config = JSON.parse(
      await readFile(path.resolve('tsconfig.node.json'), 'utf8')
    ) as TypeScriptConfig;

    expect(config.compilerOptions.lib).toEqual(['ES2022']);
    expect(config.compilerOptions).not.toHaveProperty('jsx');
    expect(config.exclude).toContain('tests/unit/renderer/**/*');
  });

  it('typechecks renderer unit tests through a dedicated DOM, JSX, and Node config', async () => {
    const [configSource, packageSource] = await Promise.all([
      readFile(path.resolve('tsconfig.renderer-tests.json'), 'utf8'),
      readFile(path.resolve('package.json'), 'utf8')
    ]);
    const config = JSON.parse(configSource) as TypeScriptConfig;
    const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> };

    expect(config.extends).toBe('./tsconfig.json');
    expect(config.compilerOptions.lib).toEqual(['ES2022', 'DOM', 'DOM.Iterable']);
    expect(config.compilerOptions.jsx).toBe('react-jsx');
    expect(config.compilerOptions.types).toContain('node');
    expect(config.include).toContain('tests/unit/renderer/**/*');
    expect(packageJson.scripts.typecheck).toContain(
      'tsc --noEmit -p tsconfig.renderer-tests.json'
    );
  });
});
