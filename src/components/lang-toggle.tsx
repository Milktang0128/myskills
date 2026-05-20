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
  // Sharp-corner, mono-uppercase segmented control matching the design's
  // "lang-pill" pattern. The sidebar version (size=sm) sits on the dark
  // ink band, so colors flip to paper-on-ink when inactive.
  const sizeCls = size === 'sm' ? 'h-5 px-2 text-[10px]' : 'h-6 px-2.5 text-[10px]';
  const isOnInk = size === 'sm';
  return (
    <div
      role="group"
      aria-label={t('app.lang.label')}
      className={cn(
        'inline-flex items-center border font-mono uppercase tracking-[0.06em]',
        isOnInk ? 'border-[rgba(212,203,184,0.25)]' : 'border-rule',
        className,
      )}
    >
      <Half
        active={locale === 'en'}
        onClick={() => setLocale('en')}
        sizeCls={sizeCls}
        onInk={isOnInk}
        aria-label="Switch to English"
      >
        {t('app.lang.en')}
      </Half>
      <Half
        active={locale === 'zh'}
        onClick={() => setLocale('zh')}
        sizeCls={sizeCls}
        onInk={isOnInk}
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
  onInk,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  sizeCls: string;
  onInk: boolean;
  children: React.ReactNode;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'leading-none transition-colors',
        sizeCls,
        onInk
          ? active
            ? 'bg-[#f2eee2] text-ink'
            : 'text-[rgba(212,203,184,0.65)] hover:text-[#f2eee2]'
          : active
            ? 'bg-ink text-[#f2eee2]'
            : 'text-mute hover:text-ink',
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
