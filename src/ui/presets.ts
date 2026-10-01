import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { uiStateFile } from "./paths.js";
import type { RunMode } from "./stages.js";

/**
 * Saved run setups, so a repeat run is two clicks instead of retyped absolute
 * paths. Each preset belongs to one flow: a feature preset holds a spec, a
 * clone preset holds what to port and where from — the UI lists each flow's
 * presets only on that flow's tab.
 *
 * A preset never holds a `--db-connection` value. That string can carry a
 * database password, and this file sits unencrypted in the repo folder — the
 * connection string is typed per run and kept only in memory (see runner.ts).
 */

export interface Preset {
  id: string;
  name: string;
  /** Presets saved before the flows were split have no mode: they are feature presets. */
  mode: RunMode;
  /** One project folder. Presets saved before BE/FE folders only have this. */
  projectPath: string;
  /** Separate target folders; the same folder in both means one project. */
  projectBe: string;
  projectFe: string;
  /** Feature flow only. */
  specPath: string;
  dbMode: "none" | "connection" | "schema-file";
  dbSchemaPath: string;
  /** Feature flow only: read-only sample project it borrows patterns from. */
  referencePath: string;
  /** Clone flow only: what to port, and the read-only BE/FE source folders. */
  what: string;
  cloneFromBe: string;
  cloneFromFe: string;
}

export type PresetInput = Omit<Preset, "id">;

export async function listPresets(): Promise<Preset[]> {
  const state = await readState();
  return state.presets;
}

export async function savePreset(input: PresetInput): Promise<Preset[]> {
  const state = await readState();
  const preset: Preset = { ...sanitize(input), id: randomUUID() };

  // Same name in the same flow means "update this one" — otherwise repeated
  // saves pile up near-identical rows. A clone preset never overwrites a
  // feature preset that happens to share its name.
  const existing = state.presets.findIndex(
    (p) => p.mode === preset.mode && p.name.toLowerCase() === preset.name.toLowerCase(),
  );
  if (existing === -1) state.presets.push(preset);
  else state.presets[existing] = { ...preset, id: state.presets[existing].id };

  await writeState(state);
  return state.presets;
}

export async function deletePreset(id: string): Promise<Preset[]> {
  const state = await readState();
  state.presets = state.presets.filter((preset) => preset.id !== id);
  await writeState(state);
  return state.presets;
}

interface UiState {
  presets: Preset[];
}

async function readState(): Promise<UiState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(uiStateFile, "utf-8"));
    const presets = (parsed as UiState | null)?.presets;
    return { presets: Array.isArray(presets) ? presets.filter(isPreset).map(withDefaults) : [] };
  } catch {
    return { presets: [] }; // Missing or corrupt: start clean rather than fail the UI.
  }
}

async function writeState(state: UiState): Promise<void> {
  await writeFile(uiStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function sanitize(input: PresetInput): PresetInput {
  return {
    name: input.name.trim().slice(0, 80),
    mode: input.mode === "clone" ? "clone" : "feature",
    projectPath: input.projectPath?.trim() ?? "",
    projectBe: input.projectBe?.trim() ?? "",
    projectFe: input.projectFe?.trim() ?? "",
    specPath: input.specPath?.trim() ?? "",
    dbMode: input.dbMode,
    dbSchemaPath: input.dbSchemaPath?.trim() ?? "",
    referencePath: input.referencePath?.trim() ?? "",
    what: input.what?.trim() ?? "",
    cloneFromBe: input.cloneFromBe?.trim() ?? "",
    cloneFromFe: input.cloneFromFe?.trim() ?? "",
  };
}

/** Fills the fields a preset saved by an older version does not have. */
function withDefaults(preset: Preset): Preset {
  return { ...preset, ...sanitize(preset), id: preset.id };
}

function isPreset(value: unknown): value is Preset {
  const candidate = value as Preset | null;
  return (
    typeof candidate?.id === "string" &&
    typeof candidate.name === "string" &&
    (typeof candidate.projectPath === "string" || typeof candidate.projectBe === "string")
  );
}
