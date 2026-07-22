import { ElementIcon } from '../../design/Icons';
import { elements, type Element } from '../../design/tokens';
import { useI18n } from '../../i18n';

export type ElementFilter = 'all' | Element;

interface RosterToolbarProps {
  filter: ElementFilter;
  filteredCount: number;
  query: string;
  totalCount: number;
  onFilterChange: (filter: ElementFilter) => void;
  onQueryChange: (query: string) => void;
}

export function RosterToolbar({
  filter,
  filteredCount,
  onFilterChange,
  onQueryChange,
  query,
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
      <p className="gta-roster-count" aria-live="polite">
        {t('roster.filteredCount', { shown: filteredCount, total: totalCount })}
      </p>
    </div>
  );
}
