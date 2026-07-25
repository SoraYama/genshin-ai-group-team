import { useState } from 'react';

import type {
  AbyssAdvisorProgressStep,
  AbyssAdvisorResult
} from '../../../../shared/abyss-advisor';
import type { CharacterProfile, PersistedProfile } from '../../../../shared/domain';
import {
  blockedIssuePresentation,
  characterElementLabel,
  localizedEvidenceReason,
  localizedPlanText,
  localizedProfileName,
  narrativeTargetBody,
  progressStepLabel,
  sourceBadge,
  type PresentationLocale
} from '../abyss-presentation';

const PROGRESS_STEPS: AbyssAdvisorProgressStep[] = [
  'reading-roster',
  'interpreting-builds',
  'checking-knowledge',
  'researching-guides',
  'analyzing-rules',
  'generating-teams',
  'checking-conflicts',
  'writing-tactics'
];

const RESULT_TABS = ['overview', 'tactics', 'evidence'] as const;
type ResultTab = (typeof RESULT_TABS)[number];

interface AbyssResultPanelProps {
  locale: PresentationLocale;
  profile: PersistedProfile;
  result: AbyssAdvisorResult | null;
  pending: boolean;
  running: boolean;
  activeStep: AbyssAdvisorProgressStep | null;
  generationError: boolean;
  cancelled: boolean;
  onOpenTrace: () => void;
  traceButtonRef: React.RefObject<HTMLButtonElement | null>;
}

export function AbyssResultPanel({
  locale,
  profile,
  result,
  pending,
  running,
  activeStep,
  generationError,
  cancelled,
  onOpenTrace,
  traceButtonRef
}: AbyssResultPanelProps) {
  const isEnglish = locale === 'en';
  const progressState: ProgressState = generationError
    ? 'error'
    : cancelled
      ? 'cancelled'
      : result?.status ?? (running ? 'running' : 'idle');
  return (
    <section
      className="abyss-panel abyss-result-panel"
      data-testid="abyss-results"
      aria-labelledby="abyss-results-title"
    >
      <header className="abyss-result-header">
        <div>
          <span>{isEnglish ? '03 · Result' : '03 · 双队结果'}</span>
          <h3 id="abyss-results-title">
            {generationError
              ? isEnglish
                ? 'Generation stopped'
                : '生成已停止'
              : cancelled
                ? isEnglish
                  ? 'Generation cancelled'
                  : '生成已取消'
                : result?.status === 'planned'
                  ? isEnglish
                    ? 'No character overlap between halves'
                    : '上下半零重复'
                  : result?.status === 'blocked'
                    ? isEnglish
                      ? 'No valid plan'
                      : '暂时无法组成两支完整队伍'
                    : isEnglish
                      ? 'Ready for generation'
                      : '等待生成方案'}
          </h3>
        </div>
        <div className="abyss-result-header-actions">
          {result && (
            <span className={`gta-abyss-source is-${result.source}`}>
              {sourceBadge(result.source, locale)}
            </span>
          )}
          <button ref={traceButtonRef} type="button" onClick={onOpenTrace}>
            {isEnglish ? 'Model run record' : '模型运行记录'}
          </button>
        </div>
      </header>

      <ProgressRail
        locale={locale}
        activeStep={activeStep}
        running={running}
        state={progressState}
      />

      {generationError ? (
        <div className="abyss-result-empty" role="alert">
          <strong>{isEnglish ? 'Generation failed' : '生成方案时发生错误'}</strong>
          <p>
            {isEnglish
              ? 'Character and challenge data were not changed. Try again.'
              : '角色与挑战资料没有被修改，可以直接重试。'}
          </p>
        </div>
      ) : cancelled ? (
        <div className="abyss-result-empty" role="status">
          <strong>{isEnglish ? 'Generation cancelled' : '生成已取消'}</strong>
          <p>
            {isEnglish
              ? 'The current choices are unchanged. Generate again when ready.'
              : '当前选择没有改变，准备好后可重新生成。'}
          </p>
        </div>
      ) : result?.status === 'blocked' ? (
        <BlockedResult result={result} locale={locale} />
      ) : result?.status === 'planned' ? (
        <PlannedResult result={result} profile={profile} pending={pending} locale={locale} />
      ) : (
        <ResultSkeleton locale={locale} running={running} />
      )}
    </section>
  );
}

type ProgressState = 'idle' | 'running' | 'planned' | 'blocked' | 'error' | 'cancelled';

function ProgressRail({
  locale,
  activeStep,
  running,
  state
}: {
  locale: PresentationLocale;
  activeStep: AbyssAdvisorProgressStep | null;
  running: boolean;
  state: ProgressState;
}) {
  const isEnglish = locale === 'en';
  const currentIndex = activeStep ? PROGRESS_STEPS.indexOf(activeStep) : -1;
  const statusLabel: Record<ProgressState, { zh: string; en: string }> = {
    idle: { zh: '等待开始', en: 'Ready' },
    running: { zh: '执行中', en: 'Running' },
    planned: { zh: '已完成', en: 'Completed' },
    blocked: { zh: '已阻断', en: 'Blocked' },
    error: { zh: '执行出错', en: 'Stopped with an error' },
    cancelled: { zh: '已取消', en: 'Cancelled' }
  };
  return (
    <ol
      className="gta-abyss-progress"
      aria-label={`${isEnglish ? 'Team planning progress' : '配队进度'} · ${statusLabel[state][locale]}`}
      aria-live="polite"
      data-running={running}
      data-state={state}
    >
      {PROGRESS_STEPS.map((step, index) => {
        const done = state === 'planned' || index < currentIndex;
        const active = index === currentIndex && !done;
        return (
          <li
            key={step}
            className={
              done
                ? 'is-done'
                : active
                  ? `is-active${state === 'running' ? '' : ` is-${state}`}`
                  : ''
            }
          >
            <span aria-hidden="true">{done ? '✓' : index + 1}</span>
            {progressStepLabel(step, locale)}
          </li>
        );
      })}
    </ol>
  );
}

function ResultSkeleton({ locale, running }: { locale: PresentationLocale; running: boolean }) {
  const isEnglish = locale === 'en';
  return (
    <div className={`abyss-result-skeleton${running ? ' is-running' : ''}`}>
      <div className="abyss-result-team-skeleton">
        <strong>{isEnglish ? 'First half' : '上半队伍'}</strong>
        <AvatarSkeleton />
      </div>
      <div className="abyss-result-team-skeleton">
        <strong>{isEnglish ? 'Second half' : '下半队伍'}</strong>
        <AvatarSkeleton />
      </div>
      <aside>
        <span>{isEnglish ? 'Knowledge coverage' : '知识覆盖'}</span>
        <strong>{isEnglish ? 'Calculated during generation' : '生成时计算'}</strong>
        <span>{isEnglish ? 'Guide search' : '攻略搜索'}</span>
        <strong>{isEnglish ? 'Not started' : '尚未开始'}</strong>
        <span>{isEnglish ? 'Primary risk' : '主要风险'}</span>
        <strong>{isEnglish ? 'Waiting for team constraints' : '等待队伍约束'}</strong>
      </aside>
    </div>
  );
}

function AvatarSkeleton() {
  return (
    <div className="abyss-result-roster gta-abyss-result-roster" aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <span key={index}>
          <i />
          <small>——</small>
        </span>
      ))}
    </div>
  );
}

function BlockedResult({
  result,
  locale
}: {
  result: Extract<AbyssAdvisorResult, { status: 'blocked' }>;
  locale: PresentationLocale;
}) {
  return (
    <div className="abyss-result-empty gta-abyss-result--blocked">
      <span className="gta-abyss-source is-blocked">{sourceBadge('blocked', locale)}</span>
      <ul>
        {result.issues.map((issue, index) => {
          const presentation = blockedIssuePresentation(issue.code, locale);
          return (
            <li key={`${issue.code}-${index}`}>
              <strong>{presentation.message}</strong>
              <span>{presentation.action}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PlannedResult({
  result,
  profile,
  pending,
  locale
}: {
  result: Extract<AbyssAdvisorResult, { status: 'planned' }>;
  profile: PersistedProfile;
  pending: boolean;
  locale: PresentationLocale;
}) {
  const [tab, setTab] = useState<ResultTab>('overview');
  const isEnglish = locale === 'en';
  const characterById = new Map(
    profile.characters.map((character) => [String(character.id), character])
  );
  const selectedCharacterIds = [
    ...result.plan.firstHalfTeam.characterIds,
    ...result.plan.secondHalfTeam.characterIds
  ];
  const firstChamber = result.plan.chambers[0];
  const localizedDetails = (items: string[]) =>
    items.flatMap((item) => {
      const localized = localizedPlanText(item, locale);
      return localized ? [localized] : [];
    });
  const firstRisk =
    result.teamRisks[0]?.narrative[isEnglish ? 'en-US' : 'zh-CN'] ??
    localizedDetails(result.warnings)[0] ??
    (isEnglish ? 'No primary risk recorded.' : '暂无主要风险。');
  const moveTabFocus = (event: React.KeyboardEvent<HTMLButtonElement>, currentTab: ResultTab) => {
    const currentIndex = RESULT_TABS.indexOf(currentTab);
    let nextIndex = currentIndex;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % RESULT_TABS.length;
    else if (event.key === 'ArrowLeft')
      nextIndex = (currentIndex - 1 + RESULT_TABS.length) % RESULT_TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = RESULT_TABS.length - 1;
    else return;

    event.preventDefault();
    const nextTab = RESULT_TABS[nextIndex] ?? currentTab;
    setTab(nextTab);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`#abyss-result-tab-${nextTab}`)
      ?.focus();
  };

  return (
    <div className="abyss-result-content">
      <div className="abyss-result-summary">
        <p>{result.narrative.summary[isEnglish ? 'en-US' : 'zh-CN']}</p>
        {pending && (
          <span className="gta-abyss-pending-badge">{isEnglish ? 'Update needed' : '待更新'}</span>
        )}
      </div>

      <div className="gta-abyss-result-teams">
        <ResultTeam
          title={isEnglish ? 'First-half team' : '上半队伍'}
          ids={result.plan.firstHalfTeam.characterIds}
          purpose={narrativeTargetBody(result.narrative, 'abyss-team:first', locale)}
          characters={characterById}
          orderedCharacterIds={selectedCharacterIds}
          locale={locale}
        />
        <ResultTeam
          title={isEnglish ? 'Second-half team' : '下半队伍'}
          ids={result.plan.secondHalfTeam.characterIds}
          purpose={narrativeTargetBody(result.narrative, 'abyss-team:second', locale)}
          characters={characterById}
          orderedCharacterIds={selectedCharacterIds}
          locale={locale}
        />
        <aside className="abyss-result-metrics">
          <span>{isEnglish ? 'Knowledge coverage' : '知识覆盖'}</span>
          <strong>
            {result.knowledgeSummary.trusted} /{' '}
            {result.knowledgeSummary.trusted +
              result.knowledgeSummary.ephemeral +
              result.knowledgeSummary.unknown}
          </strong>
          <span>{isEnglish ? 'Guide search' : '攻略搜索'}</span>
          <strong>
            {result.knowledgeSummary.searched
              ? isEnglish
                ? 'Supplemented'
                : '已补充'
              : isEnglish
                ? 'Local only'
                : '仅本地'}
          </strong>
          <span>{isEnglish ? 'Primary risk' : '主要风险'}</span>
          <strong>{firstRisk}</strong>
        </aside>
      </div>

      <div
        className="abyss-result-tabs"
        role="tablist"
        aria-label={isEnglish ? 'Result details' : '结果详情'}
      >
        {(
          [
            ['overview', isEnglish ? 'Overview' : '概览'],
            ['tactics', isEnglish ? 'Tactics' : '逐间打法'],
            ['evidence', isEnglish ? 'Evidence' : '依据']
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            id={`abyss-result-tab-${value}`}
            type="button"
            role="tab"
            aria-controls="abyss-result-tabpanel"
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => moveTabFocus(event, value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        id="abyss-result-tabpanel"
        className="abyss-result-tabpanel"
        role="tabpanel"
        aria-labelledby={`abyss-result-tab-${tab}`}
      >
        {tab === 'overview' ? (
          <div className="abyss-result-overview">
            <div>
              <strong>{isEnglish ? 'Rotation' : '循环手法'}</strong>
              <p>
                {isEnglish ? 'Rotation: ' : '循环：'}
                {localizedDetails(result.plan.firstHalfTeam.rotationNotes).join('；') ||
                  (isEnglish ? 'Follow the saved team order.' : '按保存的队伍顺序执行。')}
              </p>
            </div>
            <div>
              <strong>{isEnglish ? 'First-half tactics' : '上半打法'}</strong>
              <p>
                {firstChamber
                  ? narrativeTargetBody(
                      result.narrative,
                      `abyss-chamber:${firstChamber.floor}:${firstChamber.chamber}:first`,
                      locale
                    )
                  : isEnglish
                    ? 'No chamber tactics.'
                    : '暂无逐间打法。'}
              </p>
            </div>
            <div>
              <strong>{isEnglish ? 'Substitutions' : '替换建议'}</strong>
              <p>
                {isEnglish ? 'Substitutions: ' : '替换建议：'}
                {firstChamber
                  ? localizedDetails(firstChamber.firstHalf.substitutionNotes).join('；') ||
                    (isEnglish
                      ? 'Recalculate both teams after changes.'
                      : '调整角色后重新生成完整双队')
                  : '—'}
              </p>
            </div>
          </div>
        ) : tab === 'tactics' ? (
          <div className="gta-abyss-tactics">
            {result.plan.chambers.map((chamber) => (
              <article key={`${chamber.floor}-${chamber.chamber}`}>
                <h5>
                  {isEnglish
                    ? `Floor ${chamber.floor} · Chamber ${chamber.chamber}`
                    : `${chamber.floor} 层 · 第 ${chamber.chamber} 间`}
                </h5>
                <p>
                  {narrativeTargetBody(
                    result.narrative,
                    `abyss-chamber:${chamber.floor}:${chamber.chamber}:first`,
                    locale
                  )}
                </p>
                <p>
                  {narrativeTargetBody(
                    result.narrative,
                    `abyss-chamber:${chamber.floor}:${chamber.chamber}:second`,
                    locale
                  )}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <div className="abyss-result-evidence">
            {result.memberEvidence.map((evidence) => (
              <article key={evidence.characterId}>
                <strong>
                  {characterById.has(evidence.characterId)
                    ? localizedProfileName(
                        characterById.get(evidence.characterId)!.name,
                        evidence.characterId,
                        selectedCharacterIds,
                        locale
                      )
                    : isEnglish
                      ? 'Unknown'
                      : '未知'}
                </strong>
                <span>
                  {evidence.fitReasons
                    .map((reason) => localizedEvidenceReason(reason, locale))
                    .join(isEnglish ? '; ' : '；')}
                </span>
              </article>
            ))}
            {result.memberEvidence.length === 0 && (
              <p>{isEnglish ? 'No member evidence was recorded.' : '本次未记录单人依据。'}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultTeam({
  title,
  ids,
  purpose,
  characters,
  orderedCharacterIds,
  locale
}: {
  title: string;
  ids: string[];
  purpose: string;
  characters: Map<string, CharacterProfile>;
  orderedCharacterIds: string[];
  locale: PresentationLocale;
}) {
  const isEnglish = locale === 'en';
  return (
    <section>
      <h4>{title}</h4>
      <div className="abyss-result-roster gta-abyss-result-roster">
        {ids.map((id) => {
          const character = characters.get(id);
          const name = character
            ? localizedProfileName(character.name, id, orderedCharacterIds, locale)
            : isEnglish
              ? 'Unknown'
              : '未知';
          return (
            <span key={id} data-result-character-id={id}>
              <i aria-hidden="true">{name.slice(0, 1)}</i>
              <strong>{name}</strong>
              <small>
                {character
                  ? `${characterElementLabel(character.element, locale)} · ${character.level ?? '—'}`
                  : id}
              </small>
            </span>
          );
        })}
      </div>
      <p>{purpose}</p>
    </section>
  );
}
