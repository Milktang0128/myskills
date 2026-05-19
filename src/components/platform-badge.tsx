import { cn } from '@/lib/utils';

interface Props {
  platformId: string;
  className?: string;
}

const STYLE: Record<string, string> = {
  claude: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-300',
  codex:  'bg-purple-100 text-purple-900 dark:bg-purple-950 dark:text-purple-300',
  shared: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
};

const LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  shared: 'Shared',
};

export function PlatformBadge({ platformId, className }: Props) {
  const style = STYLE[platformId] ?? 'bg-secondary text-secondary-foreground';
  const label = LABEL[platformId] ?? platformId;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        style,
        className,
      )}
    >
      {label}
    </span>
  );
}
