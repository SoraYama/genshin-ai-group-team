import { ElementIcon } from '../../design/Icons';
import { elements, type Element } from '../../design/tokens';
import { useI18n } from '../../i18n';
import type { RosterSortMode } from './character-presentation';

export type ElementFilter = 'all' | Element;

interface RosterToolbarProps {
  filter: ElementFilter;
  filteredCount: number;
  query: string;
  sort: RosterSortMode;
  totalCount: number;
  onFilterChange: (filter: ElementFilter) => void;
  onQueryChange: (query: string) => void;
  onSortChange: (sort: RosterSortMode) => void;
}

export function RosterToolbar({
  filter,
  filteredCount,
  onFilterChange,
  onQueryChange,
  onSortChange,
  query,
  sort,
  totalCount
}: RosterToolbarProps) {
  const { t } = useI18n();
  return (
    <div className="gta-roster-toolbar">
      <label className="gta-roster-search">
        <span className="gta-field-label">{t('roster.search')}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('roster.searchPlaceholder')}
        />
      </label>
      <div className="gta-element-filters" aria-label={t('roster.filterLabel')}>
        <button
          type="button"
          aria-pressed={filter === 'all'}
          className={filter === 'all' ? 'is-active' : ''}
          onClick={() => onFilterChange('all')}
        >
          {t('roster.filterAll')}
        </button>
        {elements.map((element) => (
          <button
            type="button"
            key={element}
            aria-pressed={filter === element}
            aria-label={t(`roster.element.${element}`)}
            className={filter === element ? 'is-active' : ''}
            onClick={() => onFilterChange(element)}
          >
            <ElementIcon element={element} size={15} />
            <span>{t(`roster.elementShort.${element}`)}</span>
          </button>
        ))}
      </div>
      <label className="gta-roster-sort">
        <span className="gta-field-label">{t('roster.sort')}</span>
        <select
          value={sort}
          onChange={(event) => onSortChange(event.target.value as RosterSortMode)}
        >
          <option value="default">{t('roster.sort.default')}</option>
          <option value="level-desc">{t('roster.sort.levelDesc')}</option>
          <option value="name">{t('roster.sort.name')}</option>
          <option value="element">{t('roster.sort.element')}</option>
          <option value="completeness-desc">{t('roster.sort.completenessDesc')}</option>
        </select>
      </label>
      <p className="gta-roster-count" aria-live="polite">
        {t('roster.filteredCount', { shown: filteredCount, total: totalCount })}
      </p>
    </div>
  );
}
