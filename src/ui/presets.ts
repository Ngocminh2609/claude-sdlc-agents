import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { uiStateFile } from "./paths.js";

/**
 * Saved project/spec combinations, so a repeat run is two clicks instead of
 * two retyped absolute paths.
 *
 * A preset never holds a `--db-connection` value. That string can carry a
 * database password, and this file sits unencrypted in the repo folder — the
 * connection string is typed per run and kept only in memory (see runner.ts).
 */

export interface Preset {
  id: string;
  name: string;
  /** One project folder. Presets saved before BE/FE folders only have this. */
  projectPath: string;
  /** Separate target folders; the same folder in both means one project. */
  projectBe: string;
  projectFe: string;
  specPath: string;
  dbMode: "none" | "connection" | "schema-file";
  dbSchemaPath: string;
  /** Read-only sample project, when the run clones patterns from one. */
  referencePath: string;
}

export type PresetInput = Omit<Preset, "id">;

export async function listPresets(): Promise<Preset[]> {
  const state = await readState();
  return state.presets;
}

export async function savePreset(input: PresetInput): Promise<Preset[]> {
  const state = await readState();
  const preset: Preset = { ...sanitize(input), id: randomUUID() };

  // Same name means "update this one" — otherwise repeated saves of the same
  // project pile up near-identical rows the user then has to weed out.
  const existing = state.presets.findIndex(
    (p) => p.name.toLowerCase() === preset.name.toLowerCase(),
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
    return { presets: Array.isArray(presets) ? presets.filter(isPreset) : [] };
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
    projectPath: input.projectPath?.trim() ?? "",
    projectBe: input.projectBe?.trim() ?? "",
    projectFe: input.projectFe?.trim() ?? "",
    specPath: input.specPath.trim(),
    dbMode: input.dbMode,
    dbSchemaPath: input.dbSchemaPath?.trim() ?? "",
    referencePath: input.referencePath?.trim() ?? "",
  };
}

function isPreset(value: unknown): value is Preset {
  const candidate = value as Preset | null;
  return (
    typeof candidate?.id === "string" &&
    typeof candidate.name === "string" &&
    (typeof candidate.projectPath === "string" || typeof candidate.projectBe === "string") &&
    typeof candidate.specPath === "string"
  );
}
