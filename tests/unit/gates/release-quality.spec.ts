import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src/renderer');
const RESOURCES_ROOT = path.join(REPO_ROOT, 'resources');

describe('release security and copyright gates', () => {
  it('keeps every renderer network operation behind preload IPC', async () => {
    const files = await sourceFiles(RENDERER_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (
        /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(|\bEventSource\s*\(|\.sendBeacon\s*\(|\bimport\s*\(\s*["']https?:/u.test(
          source
        )
      ) {
        violations.push(path.relative(REPO_ROOT, file));
      }
      if (/<img\b[^>]*\bsrc\s*=\s*["'`]https?:/iu.test(source)) {
        violations.push(`${path.relative(REPO_ROOT, file)}:remote-img`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps renderer CSS and bundled visual source free of remote assets', async () => {
    const files = (await sourceFiles(RENDERER_ROOT)).filter((file) => file.endsWith('.css'));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/url\(\s*["']?https?:/iu.test(source)) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('accounts for every generated background and original/OFL visual family in credits', async () => {
    const credits = await readFile(path.join(RESOURCES_ROOT, 'credits.md'), 'utf8');
    const backgrounds = (await readdir(path.join(RESOURCES_ROOT, 'backgrounds')))
      .filter((name) => name.endsWith('.webp'))
      .map((name) => name.replace('@2x', '').replace('.webp', ''))
      .filter((name, index, values) => values.indexOf(name) === index);

    for (const background of backgrounds) {
      expect(credits, `${background} must have provenance`).toContain(
        `resources/backgrounds/${background}*.webp`
      );
    }
    expect(credits).toContain('Noto Sans SC — SIL Open Font License 1.1');
    expect(credits).toContain('JetBrains Mono — SIL Open Font License 1.1');
    expect(credits).toContain('All application SVG/CSS decorations and icons');
    expect(credits).toContain('does not bundle game artwork');
  });

  it('does not introduce filenames that imply copied game portraits, UI slices, or proprietary fonts', async () => {
    const files = await allFiles(RESOURCES_ROOT);
    const forbidden =
      /(?:official[-_. ]?(?:avatar|portrait|ui|font)|game[-_. ]?(?:avatar|portrait|ui[-_. ]?slice)|hywenhei|mihoyo[-_. ]?font)/iu;
    expect(
      files
        .map((file) => path.relative(RESOURCES_ROOT, file))
        .filter((file) => forbidden.test(file))
    ).toEqual([]);
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  return (await allFiles(root)).filter((file) => /\.(?:css|ts|tsx)$/u.test(file));
}

async function allFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(root, entry.name);
      return entry.isDirectory() ? allFiles(absolute) : [absolute];
    })
  );
  return files.flat();
}
