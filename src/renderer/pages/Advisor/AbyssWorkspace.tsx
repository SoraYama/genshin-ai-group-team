import { useRef } from 'react';

import { EmptyState } from '../../components/ui/EmptyState';
import type { HistoryRerunIntent } from '../History/history-presentation';
import { AbyssConstraintPanel } from './abyss/AbyssConstraintPanel';
import { AbyssResultPanel } from './abyss/AbyssResultPanel';
import { AbyssScenarioPanel } from './abyss/AbyssScenarioPanel';
import { AgentTraceDrawer } from './abyss/AgentTraceDrawer';
import { useAbyssWorkbench } from './abyss/useAbyssWorkbench';
import './abyss/abyss-workbench.css';
import { scenarioUnavailableCopy } from './scenario-unavailable-presentation';

interface AbyssWorkspaceProps {
  uid: string;
  historyRerun?: Extract<HistoryRerunIntent, { mode: 'spiral-abyss' }>;
  onHistoryRerunConsumed?: (historyId: string) => void;
  onBack: () => void;
}

export function AbyssWorkspace({
  uid,
  historyRerun,
  onHistoryRerunConsumed,
  onBack
}: AbyssWorkspaceProps) {
  const workbench = useAbyssWorkbench({ uid, historyRerun, onHistoryRerunConsumed });
  const traceButtonRef = useRef<HTMLButtonElement | null>(null);
  const isEnglish = workbench.language === 'en';

  if (workbench.loadError === 'load') {
    return (
      <div className="gta-abyss-unavailable" role="alert">
        <EmptyState kind="offline" locale={workbench.language} />
        <p>
          {isEnglish
            ? 'Spiral Abyss data could not be loaded. Try again later.'
            : '读取深境螺旋资料失败，请稍后重试。'}
        </p>
      </div>
    );
  }
  if (!workbench.scenarioView || !workbench.profile) {
    return (
      <div className="gta-abyss-unavailable">
        {isEnglish ? 'Loading roster and challenge data…' : '正在读取角色与挑战资料…'}
      </div>
    );
  }
  if (workbench.scenarioView.status === 'unavailable') {
    return (
      <section className="gta-abyss-unavailable" aria-labelledby="abyss-unavailable-title">
        <span className="gta-page-kicker">{isEnglish ? 'Spiral Abyss' : '深境螺旋'}</span>
        <div id="abyss-unavailable-title">
          <EmptyState
            kind="offline"
            locale={workbench.language}
            copy={scenarioUnavailableCopy(workbench.scenarioView.reason, workbench.language)}
          />
        </div>
        <p>
          {isEnglish
            ? 'Verified challenge data is unavailable. Saved plans remain available.'
            : `${workbench.scenarioView.message} 你仍可查看角色与历史方案。`}
        </p>
      </section>
    );
  }

  const scenarioView = workbench.scenarioView;
  const generationBlocked =
    workbench.tooManyLocks || workbench.selectedChambers.length === 0 || workbench.scenarioReadOnly;

  return (
    <>
      <section className="abyss-workbench" aria-labelledby="abyss-workspace-title">
        <header className="abyss-workbench-toolbar">
          <div>
            <span>{isEnglish ? 'Spiral Abyss · joint planning' : '深境螺旋 · 双队联合规划'}</span>
            <h2 id="abyss-workspace-title">
              {isEnglish ? 'Spiral Abyss planner' : '深境螺旋战线'}
            </h2>
          </div>
          <div className="abyss-workbench-status">
            {scenarioView.trust === 'development-sample' && (
              <strong>
                {isEnglish ? 'Practice data — not the current cycle' : '演练资料，不代表本期'}
              </strong>
            )}
            {scenarioView.trust === 'production' && scenarioView.refreshWarning && (
              <strong>
                {isEnglish ? 'Using the latest verified snapshot' : '正在使用最近一次已确认资料'}
              </strong>
            )}
            {workbench.historyNotice && (
              <>
                <strong>{isEnglish ? 'Saved plan ready' : '旧方案已准备'}</strong>
                <span title={workbench.historyNotice}>
                  {isEnglish
                    ? 'Saved choices restored; the smart service will not start automatically.'
                    : workbench.historyNotice}
                </span>
              </>
            )}
            {workbench.tooManyLocks && (
              <span role="alert">
                {isEnglish
                  ? 'At most 8 characters can be locked.'
                  : `最多锁定 8 名角色；请取消 ${workbench.lockedCharacterIds.length - 8} 名。`}
              </span>
            )}
            <button type="button" onClick={onBack}>
              {isEnglish ? 'Change challenge' : '切换挑战'}
            </button>
          </div>
        </header>

        <div className="abyss-input-grid">
          <AbyssConstraintPanel
            locale={workbench.language}
            characters={workbench.characters}
            preferences={workbench.preferences}
            interventions={workbench.interventions}
            lockedCharacterIds={workbench.lockedCharacterIds}
            excludedCharacterIds={workbench.excludedCharacterIds}
            running={workbench.running}
            blocked={generationBlocked}
            resultNeedsUpdate={workbench.resultNeedsUpdate}
            canRecomputeHalf={workbench.result?.status === 'planned'}
            onTogglePreference={workbench.togglePreference}
            onCycleCharacter={workbench.cycleCharacter}
            onGenerate={(half) => void workbench.generatePlan(half)}
            onCancel={workbench.cancelPlan}
          />
          <AbyssScenarioPanel
            locale={workbench.language}
            scenarioView={scenarioView}
            floorNumber={workbench.floorNumber}
            chamberNumber={workbench.chamberNumber}
            selectedChambers={workbench.selectedChambers}
            running={workbench.running}
            readOnly={workbench.scenarioReadOnly}
            onChooseFloor={workbench.chooseFloor}
            onChooseChamber={workbench.chooseChamber}
          />
        </div>

        <AbyssResultPanel
          locale={workbench.language}
          profile={workbench.profile}
          result={workbench.result}
          pending={workbench.resultNeedsUpdate}
          running={workbench.running}
          activeStep={workbench.activeStep}
          generationError={workbench.loadError === 'generate'}
          cancelled={workbench.cancelled}
          onOpenTrace={workbench.openTrace}
          traceButtonRef={traceButtonRef}
        />
      </section>

      <AgentTraceDrawer
        open={workbench.traceOpen}
        loading={workbench.traceLoading}
        failedToLoad={workbench.traceError}
        trace={workbench.trace}
        locale={workbench.language}
        returnFocusRef={traceButtonRef}
        onClose={workbench.closeTrace}
      />
    </>
  );
}
