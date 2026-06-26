import { cn } from '@/lib/utils';

interface Props {
  platformId: string;
  className?: string;
}

const STYLE: Record<string, string> = {
  claude: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-300',
  codex:  'bg-purple-100 text-purple-900 dark:bg-purple-950 dark:text-purple-300',
  shared: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  openclaw: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-300',
  opencode: 'bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-300',
  gemini: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-300',
  goose:  'bg-lime-100 text-lime-900 dark:bg-lime-950 dark:text-lime-300',
  hermes: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-300',
};

// Short badge labels — rendered uppercase by the CSS `uppercase` utility.
// The `shared` platform's id stays `shared` for DB compatibility, but the
// visible chip reads "USER" to align with the renamed "User Agents Folder"
// concept used everywhere else in the UI (sidebar, onboarding, settings).
const LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  shared: 'User',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  goose: 'Goose',
  hermes: 'Hermes',
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
