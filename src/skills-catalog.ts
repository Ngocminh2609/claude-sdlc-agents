import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import type { ProjectRoot } from "./target-roots.js";

/**
 * The installed FIS skill catalog, exposed to the stages that design, review
 * or write code so they can follow a matching skill the same way any other
 * session in this environment routes one — by its description, not by a fixed
 * per-stage mapping this file would have to keep in sync with the kit.
 *
 * Two sources, merged: the machine's global catalog (`~/.claude/skills` — the
 * full FIS AI Kit) and each target folder's own `.claude/skills` (project- or
 * repo-specific skills, e.g. one generated crud scaffold a single backend
 * keeps for itself). A project-local skill wins over a same-named global one,
 * matching this environment's own "most specific wins" convention. A repo
 * with neither directory gets an empty catalog — the exact "not found, skip"
 * behaviour the tool had before this existed.
 */

export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** From frontmatter, if the skill declares any — the strongest relevance signal `relevantSkillCatalog` has. */
  keywords: string[];
  /** Absolute path to SKILL.md, for the agent to Read before following it. */
  path: string;
}

export interface SkillCatalog {
  /** What a stage actually sees — the full installed set until `relevantSkillCatalog` narrows it. */
  entries: SkillCatalogEntry[];
  /** Directories outside the target roots that must be opened read-only so entries there are reachable. */
  readOnlyDirs: string[];
  /** How many skills were installed before any relevance filtering — for the progress line and diagnostics. */
  totalInstalled: number;
}

export const DEFAULT_GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");

function skillsIn(skillsDir: string): SkillCatalogEntry[] {
  if (!existsSync(skillsDir)) return [];
  const entries: SkillCatalogEntry[] = [];
  for (const name of readdirSync(skillsDir)) {
    const skillMd = path.join(skillsDir, name, "SKILL.md");
    if (!existsSync(skillMd) || !statSync(skillMd).isFile()) continue;
    const frontmatter = parseFrontmatter(readFileSync(skillMd, "utf-8"));
    // A broken or missing frontmatter skips just that one skill — never fails a run.
    if (!frontmatter?.description) continue;
    entries.push({
      name: frontmatter.name ?? name,
      description: frontmatter.description,
      keywords: Array.isArray(frontmatter.keywords) ? frontmatter.keywords.map(String) : [],
      path: skillMd,
    });
  }
  return entries;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  keywords?: unknown;
}

function parseFrontmatter(text: string): SkillFrontmatter | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    const data = parse(match[1]);
    return data && typeof data === "object" ? (data as SkillFrontmatter) : null;
  } catch {
    return null;
  }
}

export function loadSkillCatalog(
  roots: ProjectRoot[],
  globalSkillsDir: string = DEFAULT_GLOBAL_SKILLS_DIR,
): SkillCatalog {
  const byName = new Map<string, SkillCatalogEntry>();
  for (const entry of skillsIn(globalSkillsDir)) byName.set(entry.name, entry);
  // Project-local skills are read after the global ones, so they overwrite on a name clash.
  for (const root of roots) {
    for (const entry of skillsIn(path.join(root.path, ".claude", "skills"))) byName.set(entry.name, entry);
  }
  const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { entries, readOnlyDirs: existsSync(globalSkillsDir) ? [globalSkillsDir] : [], totalInstalled: entries.length };
}

/**
 * Narrows a catalog to the skills relevant to `queryText` (the spec, or
 * `clone --what`), ranked and capped at `limit` — the mechanism that keeps a
 * machine with dozens of skills installed from paying for all of them on
 * every stage call regardless of whether any apply.
 *
 * Scoring is plain keyword overlap, diacritic- and case-insensitive (so it
 * still works against a Vietnamese spec): a skill's own `keywords` count for
 * more than words picked out of its name or description, since keywords are
 * an explicit relevance signal the skill author chose. A skill with no
 * overlap at all is dropped rather than kept as a low-ranked filler — the
 * point is "not relevant, skip", the same fallback an empty catalog already
 * has, not "send the top N regardless of fit".
 *
 * Known limitation, stated rather than hidden: `clone --what` is often a short
 * Vietnamese phrase with no token overlap against this kit's English
 * keywords, so clone-mode ranking leans on whatever else is folded into
 * `queryText` (the reference/target paths, a "Bối cảnh" note with English
 * terms) more than on `--what` itself.
 */
export function relevantSkillCatalog(
  catalog: SkillCatalog,
  queryText: string,
  limit: number,
): SkillCatalog {
  const queryTokens = tokenize(queryText);
  const ranked = catalog.entries
    .map((entry) => ({ entry, score: relevanceScore(entry, queryTokens) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map((scored) => scored.entry);
  return { entries: ranked, readOnlyDirs: catalog.readOnlyDirs, totalInstalled: catalog.totalInstalled };
}

function normalize(text: string): string {
  // NFD + strip combining marks turns Vietnamese diacritics (à, ệ, ơ, …) into
  // their bare Latin letters, so "đơn vị" and "don vi" tokenize the same way.
  return text.normalize("NFD").replace(/[̀-ͯđĐ]/g, (ch) => (ch === "đ" ? "d" : ch === "Đ" ? "D" : "")).toLowerCase();
}

function tokenize(text: string): Set<string> {
  return new Set(normalize(text).split(/[^a-z0-9]+/).filter((token) => token.length > 2));
}

function relevanceScore(entry: SkillCatalogEntry, queryTokens: Set<string>): number {
  const keywordTokens = new Set(entry.keywords.flatMap((keyword) => [...tokenize(keyword)]));
  const nameTokens = tokenize(entry.name.replace(/^fis[:-]?/, ""));
  const descriptionTokens = tokenize(entry.description);
  let score = 0;
  for (const token of keywordTokens) if (queryTokens.has(token)) score += 3;
  for (const token of nameTokens) if (queryTokens.has(token)) score += 2;
  for (const token of descriptionTokens) if (queryTokens.has(token)) score += 1;
  return score;
}

/** One progress line, printed whether or not any skills were found or matched. */
export function describeSkillCatalog(catalog: SkillCatalog | null | undefined): string {
  if (!catalog || catalog.totalInstalled === 0) {
    return "Skills: none found (global and per-project .claude/skills both empty).";
  }
  if (!catalog.entries.length) {
    return `Skills: 0/${catalog.totalInstalled} relevant to this task — none applied.`;
  }
  return `Skills: ${catalog.entries.length}/${catalog.totalInstalled} relevant (${catalog.entries.map((entry) => entry.name).join(", ")})`;
}

/** `additionalDirectories` a stage needs beyond its own, so the agent can actually open a catalog entry. */
export function withSkillDirs(dirs: string[], catalog: SkillCatalog | null | undefined): string[] {
  return [...new Set([...dirs, ...(catalog?.readOnlyDirs ?? [])])];
}

/** Prompt block for one stage. Empty when the catalog is empty — a run with no skills reads as it did before. */
export function skillCatalogPromptSection(catalog: SkillCatalog | null | undefined): string[] {
  if (!catalog?.entries.length) return [];
  return [
    "",
    "--- Installed skills available for this task ---",
    "Route to one of these the same way any other session in this environment does: match your task to",
    "a capability by the description below. If one clearly covers what you are about to do, Read its",
    "SKILL.md at the path given and follow it for that part of the work — several can combine. If none",
    "match, proceed exactly as you would otherwise; do not force-fit one.",
    ...catalog.entries.map((entry) => `- ${entry.name}: ${entry.description} (${entry.path})`),
  ];
}

/** What a saved plan depends on: which skills were available and what they said. */
export function skillCatalogFingerprint(catalog: SkillCatalog | null | undefined): string[] | null {
  if (!catalog?.entries.length) return null;
  return catalog.entries.map((entry) => `${entry.name}\u0000${entry.description}\u0000${entry.path}`);
}
