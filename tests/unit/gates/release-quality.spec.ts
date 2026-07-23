import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

  it('replaces the renderer HTML CSP placeholder with a strict production policy', async () => {
    const html = await readFile(path.join(RENDERER_ROOT, 'index.html'), 'utf8');
    const vite = await readFile(path.join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const main = await readFile(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf8');
    expect(html).toContain('content="__GTA_RENDERER_CSP__"');
    expect(vite).toContain("connect-src 'none'");
    expect(vite).toContain("object-src 'none'");
    expect(vite).toContain("form-action 'none'");
    expect(main).toContain('webRequest.onBeforeRequest');
    expect(main).toContain("callback({ cancel: !allowedDevelopmentTransport })");
  });

  it('keeps text-only perceptual baselines for every release viewport and key surface', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['test:e2e:visual']).toContain('GTA_E2E_VERIFY_VISUALS=1');
    expect(packageJson.scripts['gate:all']).toContain('test:e2e:visual');
    const baselines = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'tests/e2e/visual-signatures.json'), 'utf8')
    ) as Record<string, { hash: string; maxDistance: number }>;
    const surfaces = [
      'onboarding',
      'roster-expanded-detail',
      'roster-delete-dialog',
      'advisor-details',
      'history',
      'settings',
      'abyss-input-and-result',
      'stygian-input-and-result',
      'theater-eligibility',
      'theater-route'
    ];
    const viewports = ['1024x768', '1280x800', '1440x900', '1600x1000'];
    expect(Object.keys(baselines).sort()).toEqual(
      surfaces.flatMap((surface) => viewports.map((viewport) => `${surface}-${viewport}`)).sort()
    );
    for (const baseline of Object.values(baselines)) {
      expect(baseline.hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(baseline.maxDistance).toBeGreaterThan(0);
      expect(baseline.maxDistance).toBeLessThanOrEqual(24);
    }
  });

  it('accounts for every generated background and font dependency in credits', async () => {
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
    expect(credits).toContain('All application SVG/CSS decorations and non-element icons');
  });

  it('accounts for every bundled official element icon by source and sha256', async () => {
    const directory = path.join(RESOURCES_ROOT, 'official/genshin-elements');
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as {
      owner: string;
      sourcePage: string;
      icons: Record<string, { file: string; source: string; sha256: string }>;
    };
    expect(manifest.owner).toBe('COGNOSPHERE / HoYoverse');
    expect(Object.keys(manifest.icons).sort()).toEqual([
      'anemo',
      'cryo',
      'dendro',
      'electro',
      'geo',
      'hydro',
      'pyro'
    ]);
    for (const icon of Object.values(manifest.icons)) {
      const data = await readFile(path.join(directory, icon.file));
      expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(createHash('sha256').update(data).digest('hex')).toBe(icon.sha256);
      expect(icon.source).toMatch(/^https:\/\/wiki\.hoyolab\.com\//u);
    }
    const credits = await readFile(path.join(RESOURCES_ROOT, 'credits.md'), 'utf8');
    expect(credits).toContain('HoYoLAB official Wiki element icons');
    expect(credits).toContain(manifest.sourcePage);
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
