/**
 * Curated registry of SKILL.md-compatible agent platforms.
 *
 * MySkills probes each candidate's default location at scan-time and offers
 * the user a one-click "Enable" for any that exist. Users can also add
 * fully custom platforms via the Settings UI.
 *
 * The SKILL.md format (YAML frontmatter with at least a `name` field +
 * Markdown body) has become the de-facto standard among agent tools that
 * support pluggable skills. Tools that use a different format (Cursor
 * `.cursorrules`, Cline `.clinerules`, Continue `config.json` etc.) are
 * intentionally NOT listed here — they would need separate adapters.
 *
 * To add a new known platform: append a row below with its default skills
 * directory (use `~` for home, it will be expanded at scan time).
 */
export interface KnownPlatformCandidate {
  id: string;
  label: string;
  /** Default user-level skills directory. May not exist; that's what probe checks. */
  defaultDir: string;
  /** Short description shown next to the candidate in the wizard. */
  description: string;
}

export const KNOWN_PLATFORMS: KnownPlatformCandidate[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    defaultDir: '~/.claude/skills',
    description: "Anthropic's Claude Code CLI",
  },
  {
    id: 'codex',
    label: 'Codex',
    defaultDir: '~/.codex/skills',
    description: 'Codex CLI',
  },
  {
    id: 'shared',
    label: 'Shared Pool',
    defaultDir: '~/.agents/skills',
    description: 'User-maintained pool that other platforms symlink to',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    defaultDir: '~/.opencode/skills',
    description: 'OpenCode CLI (sst/opencode)',
  },
];
