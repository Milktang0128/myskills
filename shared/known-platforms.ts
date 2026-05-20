/**
 * Curated registry of SKILL.md-compatible agent platforms.
 *
 * MySkills probes each candidate's default location at scan-time and offers
 * the user a one-click "Enable" for any that exist. Users can also add
 * fully custom platforms via the Settings UI.
 *
 * # What's in this list (and what isn't)
 *
 * Only platforms whose canonical skill format is **SKILL.md** (YAML
 * frontmatter + Markdown body, one skill per directory) are auto-detected
 * here. This is a curated set, not a discovery layer — we'd rather miss a
 * platform than wrongly suggest one. The four officially-supported entries:
 *
 *   - claude     — Anthropic Claude Code
 *   - codex      — OpenAI Codex CLI
 *   - openclaw   — OpenClaw
 *   - shared     — the cross-tool user agents folder (`~/.agents/skills`)
 *                  (DB id is still `shared`; label/description rebranded
 *                  away from "Shared Pool" because users found it opaque.
 *                  The convention itself is shared by OpenClaw, OpenCode,
 *                  and others.)
 *
 * Note on OpenCode: not listed separately because it reads from the user
 * agents folder (`~/.agents/skills`) — the `shared` entry already covers
 * it. Adding a fake `~/.opencode/skills` candidate misled users into
 * thinking it had its own dir.
 *
 * # What's intentionally NOT here
 *
 * Tools that use a different on-disk format are out of scope for
 * auto-detection because MySkills cannot read or write their files without
 * a separate adapter. Notable examples: Cursor (`.cursorrules` /
 * `.cursor/rules/`), Windsurf (`.windsurfrules`), Cline (`.clinerules`),
 * Continue (`config.json`), GitHub Copilot (repo-level instructions),
 * VS Code Cursor-forks (Junie / Kilo / Roo / Pear AI). Users who keep
 * SKILL.md folders for these tools manually can still register the path
 * via "Add custom platform" in Settings.
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
  // `shared` first: it's the recommended canonical platform (and the safest
  // default in the onboarding canonical-pick step). Putting it at the top of
  // the discovery list keeps the wizard's two suggestions consistent and
  // makes the cross-tool concept the first thing users see.
  {
    id: 'shared',
    label: 'User Agents Folder',
    defaultDir: '~/.agents/skills',
    description:
      'User-scoped folder shared across agent tools — OpenClaw and others read from here by convention',
  },
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
    id: 'openclaw',
    label: 'OpenClaw',
    defaultDir: '~/.openclaw/skills',
    description: 'OpenClaw — open-source Claude-Code-compatible agent',
  },
];
