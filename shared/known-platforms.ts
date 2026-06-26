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
 * platform than wrongly suggest one. The supported entries (each has a
 * confirmed user-level SKILL.md directory as of 2026-06):
 *
 *   - shared     — the cross-tool user agents folder (`~/.agents/skills`),
 *                  recognized by Gemini CLI, OpenCode, Goose and others as a
 *                  shared alias. (DB id stays `shared`; label rebranded away
 *                  from "Shared Pool" because users found it opaque.)
 *   - claude     — Anthropic Claude Code        (`~/.claude/skills`)
 *   - codex      — OpenAI Codex CLI             (`~/.codex/skills`)
 *   - openclaw   — OpenClaw                     (`~/.openclaw/skills`)
 *   - opencode   — OpenCode                     (`~/.config/opencode/skills`)
 *   - gemini     — Google Gemini CLI            (`~/.gemini/skills`)
 *   - goose      — Goose by Block               (`~/.config/goose/skills`)
 *   - hermes     — Hermes Agent (Nous Research) (`~/.hermes/skills`)
 *
 * Note on OpenCode: it DOES have its own native global dir
 * (`~/.config/opencode/skills`) in addition to reading `~/.claude` and
 * `~/.agents` — so it now gets its own entry (an earlier version omitted it
 * on the assumption it only read the shared folder). Gemini CLI and Goose
 * likewise keep their own dir while also honoring the `~/.agents` alias, so
 * the `shared` entry and their native entries can both surface skills.
 *
 * # What's intentionally NOT here
 *
 * Tools that use a different on-disk format are out of scope for
 * auto-detection because MySkills cannot read or write their files without
 * a separate adapter. Notable examples: Cursor (manual SKILL.md placement,
 * no standard global dir), Windsurf (`.windsurfrules`), Cline
 * (`.clinerules`), Continue (`config.json`), GitHub Copilot (repo-level
 * instructions, no user-level skills dir). Users who keep SKILL.md folders
 * for these tools manually can still register the path via "Add custom
 * platform" in Settings.
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
  {
    id: 'opencode',
    label: 'OpenCode',
    defaultDir: '~/.config/opencode/skills',
    description: 'OpenCode — its own global skills dir (also reads ~/.claude and ~/.agents)',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    defaultDir: '~/.gemini/skills',
    description: "Google's Gemini CLI (also recognizes the ~/.agents alias)",
  },
  {
    id: 'goose',
    label: 'Goose',
    defaultDir: '~/.config/goose/skills',
    description: 'Goose by Block — open-source agent',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    defaultDir: '~/.hermes/skills',
    description: 'Hermes Agent by Nous Research',
  },
];
