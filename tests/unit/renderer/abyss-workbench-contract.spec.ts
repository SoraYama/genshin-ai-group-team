import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ADVISOR_ROOT = path.resolve('src/renderer/pages/Advisor');
const ABYSS_ROOT = path.join(ADVISOR_ROOT, 'abyss');

describe('abyss workbench interaction contract', () => {
  it('keeps character intervention focused on lock and exclude without roster search', async () => {
    const [workspace, panel, hook] = await Promise.all([
      readFile(path.join(ADVISOR_ROOT, 'AbyssWorkspace.tsx'), 'utf8'),
      readFile(path.join(ABYSS_ROOT, 'AbyssConstraintPanel.tsx'), 'utf8'),
      readFile(path.join(ABYSS_ROOT, 'useAbyssWorkbench.ts'), 'utf8')
    ]);

    expect(panel).not.toContain('type="search"');
    expect(panel).not.toContain('shown');
    expect(panel).not.toContain('显示 ${characters.length} 名');
    expect(workspace).not.toContain('search={workbench.search}');
    expect(hook).not.toContain("const [search, setSearch] = useState('')");
  });

  it('never aliases an input summary to model raw output', async () => {
    const drawer = await readFile(path.join(ABYSS_ROOT, 'AgentTraceDrawer.tsx'), 'utf8');

    expect(drawer).not.toContain('stage.rawOutput ?? stage.inputSummary');
    expect(drawer).toContain("isEnglish ? 'Input summary' : '输入摘要'");
    expect(drawer).toContain("isEnglish ? 'Model raw output' : '模型原文'");
    expect(drawer).toContain('stage.rawOutput');
  });

  it('limits the workbench to drawer slide and skeleton pulse motion', async () => {
    const [workbenchCss, drawerCss] = await Promise.all([
      readFile(path.join(ABYSS_ROOT, 'abyss-workbench.css'), 'utf8'),
      readFile(path.join(ABYSS_ROOT, 'agent-trace-drawer.css'), 'utf8')
    ]);
    const keyframes = [...`${workbenchCss}\n${drawerCss}`.matchAll(/@keyframes\s+([\w-]+)/gu)]
      .map((match) => match[1])
      .sort();

    expect(keyframes).toEqual(['abyss-skeleton-pulse', 'agent-trace-enter']);
    expect(workbenchCss).not.toContain('animation: abyss-workbench-enter');
    expect(workbenchCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(drawerCss).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('does not retain the unreachable legacy Abyss stylesheet namespace', async () => {
    const advisorCss = await readFile(
      path.resolve('src/renderer/styles/pages/advisor.css'),
      'utf8'
    );

    expect(advisorCss).not.toContain('.gta-advisor-legacy-abyss');
    expect(advisorCss).not.toContain('@keyframes gta-abyss-reveal');
    expect(advisorCss).not.toContain('@keyframes gta-abyss-result-reveal');
  });
});
