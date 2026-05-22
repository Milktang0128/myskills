'use client';

/**
 * Two-state EN/中 toggle. Lives in the sidebar footer (always reachable).
 * Behaves like an iOS-style segmented control — the active half is filled.
 *
 * The toggle is intentionally tiny (no icon, no dropdown) because there
 * are only two languages and switching is instantaneous.
 */
import { useI18n, type Locale } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Props {
  className?: string;
  /** Smaller variant for the sidebar footer; default is the standard size. */
  size?: 'sm' | 'md';
}

export function LangToggle({ className, size = 'md' }: Props) {
  const { locale, setLocale, t } = useI18n();
  const sizeCls = size === 'sm' ? 'h-6 px-1.5 text-[10px]' : 'h-7 px-2 text-xs';
  return (
    <div
      role="group"
      aria-label={t('app.lang.label')}
      className={cn(
        'inline-flex items-center rounded-md border bg-card p-0.5',
        className,
      )}
    >
      <Half
        active={locale === 'en'}
        onClick={() => setLocale('en')}
        sizeCls={sizeCls}
        aria-label="Switch to English"
      >
        {t('app.lang.en')}
      </Half>
      <Half
        active={locale === 'zh'}
        onClick={() => setLocale('zh')}
        sizeCls={sizeCls}
        aria-label="切换到中文"
      >
        {t('app.lang.zh')}
      </Half>
    </div>
  );
}

function Half({
  active,
  onClick,
  sizeCls,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  sizeCls: string;
  children: React.ReactNode;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // rounded-none matches the right-angle geometry; arbitrary radii bypass
        // the tailwind config's zero-out and would re-introduce roundness here.
        'rounded-none font-medium leading-none transition-colors',
        sizeCls,
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Pick a locale label outside of components (e.g. for direct API call). */
export function localeLabel(locale: Locale): string {
  return locale === 'zh' ? '中' : 'EN';
}
