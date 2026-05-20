import { cn } from '@/lib/utils';

interface Props {
  platformId: string;
  className?: string;
  /** True if this is the canonical platform — wears the brand red instead. */
  canonical?: boolean;
}

// Mono uppercase pill with a hairline border — the editorial replacement
// for shadcn's filled pill. All non-canonical platforms use a neutral
// ink-on-paper treatment; canonical wears the vermillion border + text so
// it reads as "this is the source of truth" without needing an icon.
//
// The `shared` platform id stays `shared` for DB compatibility, but the
// visible chip reads "USER" to align with the renamed "User Agents Folder"
// concept used everywhere else in the UI.
const LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  shared: 'User',
};

export function PlatformBadge({ platformId, className, canonical }: Props) {
  const label = LABEL[platformId] ?? platformId;
  return (
    <span
      className={cn(
        'inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-[0.08em]',
        canonical ? 'border-red-brand text-red-brand' : 'border-rule text-soft',
        className,
      )}
    >
      {label}
    </span>
  );
}
