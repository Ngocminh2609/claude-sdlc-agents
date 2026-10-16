import { describe, expect, it } from "vitest";
import { modelOf, modelsInUse, promptCacheEnv, stageOptions } from "./config.js";

describe("prompt cache policy", () => {
  it("turns caching off for the tool-less SQL calls, whose cache is never read back", () => {
    expect(promptCacheEnv("sqlOptimize").DISABLE_PROMPT_CACHING).toBe("1");
    expect(promptCacheEnv("sqlCheck").DISABLE_PROMPT_CACHING).toBe("1");
  });

  it("uses the cheaper 5-minute cache for stages whose turns follow each other quickly", () => {
    for (const stage of ["specsArch", "taskBreakdown", "coding", "clonePort"] as const) {
      expect(promptCacheEnv(stage).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("5m");
      expect(promptCacheEnv(stage).DISABLE_PROMPT_CACHING).toBeUndefined();
    }
  });

  it("keeps the 1-hour cache where one call can run a whole build or test suite", () => {
    for (const stage of ["e2e", "cloneBuild", "cloneTests", "cloneFix"] as const) {
      expect(promptCacheEnv(stage).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
    }
  });

  it("passes the process environment through, since the SDK replaces env instead of merging it", () => {
    process.env.AIDEV_CONFIG_TEST_MARKER = "kept";
    try {
      expect(stageOptions("coding").env.AIDEV_CONFIG_TEST_MARKER).toBe("kept");
    } finally {
      delete process.env.AIDEV_CONFIG_TEST_MARKER;
    }
  });
});

describe("model per stage", () => {
  it("runs judgment stages on the strong tier and plan-following stages on the standard one", () => {
    const env = {};
    for (const stage of ["specDraft", "specsArch", "orchestratorReview", "cloneMapping", "sqlCheck"] as const) {
      expect(modelOf(stage, env)).toBe("claude-opus-5-5");
    }
    for (const stage of ["coding", "e2e", "taskBreakdown", "projectContext", "clonePort", "sqlOptimize"] as const) {
      expect(modelOf(stage, env)).toBe("claude-sonnet-5-5");
    }
    expect(modelsInUse(env)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  });

  it("lets CLAUDE_MODEL put every stage but the SQL check on one model, as before tiers", () => {
    const env = { CLAUDE_MODEL: "claude-opus-5-5" };
    expect(modelOf("coding", env)).toBe("claude-opus-5-5");
    expect(modelOf("specsArch", env)).toBe("claude-opus-5-5");
    expect(modelsInUse(env)).toEqual(["claude-opus-5-5"]);
    expect(modelOf("sqlCheck", { CLAUDE_MODEL: "claude-sonnet-5-5" })).toBe("claude-opus-5-5");
  });

  it("takes a tier override, and the SQL check's own override first", () => {
    expect(modelOf("coding", { AIDEV_MODEL_STANDARD: "claude-x" })).toBe("claude-x");
    expect(modelOf("specsArch", { AIDEV_MODEL_STRONG: "claude-y" })).toBe("claude-y");
    expect(modelOf("sqlCheck", { AIDEV_MODEL_STRONG: "claude-y", AIDEV_SQL_CHECK_MODEL: "claude-z" })).toBe("claude-z");
  });
});
