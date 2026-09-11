/**
 * src/llm/__tests__/systemPrompt.test.ts
 *
 * Tests for the 4-layer system prompt construction (WS1-T4).
 *
 * Per spec (section 8.1, 8.2):
 *   - All four `// Layer N: <label>` headers are present and in order
 *   - Context injection includes every PromptContext field
 *   - `[prompt:X]` invisible comment is appended (Appendix C)
 *   - Every AgentRole has non-empty MODE_INSTRUCTIONS
 *   - Empty project memory does not emit the "Known dead ends" header
 */

import { describe, expect, it } from "vitest"

import {
  SYSTEM_PROMPT_PROVENANCE,
  SYSTEM_PROMPT_PROTOCOL_VERSION,
  SYSTEM_PROMPT_VERSION,
  buildAgentSystemPrompt,
  buildSystemPrompt,
  deriveRoleFromMode,
} from "../systemPrompt"

import { buildEmptyContext } from "../types"

import { MODE_INSTRUCTIONS } from "../prompts"

import type { AgentRole, PromptContext } from "../types"

describe("systemPrompt versioning", () => {
  it("exports SYSTEM_PROMPT_VERSION at 1.2.0", () => {
    expect(SYSTEM_PROMPT_VERSION).toBe("1.2.0")
  })

  it("exports SYSTEM_PROMPT_PROTOCOL_VERSION matching the tool-call protocol", () => {
    expect(SYSTEM_PROMPT_PROTOCOL_VERSION).toBe("openai/v1")
  })

  it("exports SYSTEM_PROMPT_PROVENANCE pointing at bonafide/ws1", () => {
    expect(SYSTEM_PROMPT_PROVENANCE).toBe("bonafide/ws1")
  })
})

describe("buildAgentSystemPrompt — 4-layer structure", () => {
  it("returns all four layers tagged and in order", () => {
    const prompt = buildAgentSystemPrompt("debugger", buildEmptyContext())

    // Header markers in order.
    const layer1Idx = prompt.indexOf("// Layer 1:")
    const layer2Idx = prompt.indexOf("// Layer 2:")
    const layer3Idx = prompt.indexOf("// Layer 3:")
    const layer4Idx = prompt.indexOf("// Layer 4:")

    expect(layer1Idx).toBeGreaterThanOrEqual(0)
    expect(layer2Idx).toBeGreaterThan(layer1Idx)
    expect(layer3Idx).toBeGreaterThan(layer2Idx)
    expect(layer4Idx).toBeGreaterThan(layer3Idx)
  })

  it("injects context for each PromptContext field", () => {
    const ctx: PromptContext = {
      workspacePath: "/Users/me/ml-projects/resnet-cifar",
      trackerKind: "wandb",
      projectName: "resnet-cifar",
      experimentCount: 5,
      activeExperiments: 2,
      budgetRemaining: { gpuHours: 7.5, dollars: 12.0 },
      projectMemory: { deadEnds: [], insights: [] },
      selectedRunId: "abc123def",
      selectedRunMetrics: { val_loss: 0.42, accuracy: 0.78 },
    }

    const prompt = buildAgentSystemPrompt("debugger", ctx)

    expect(prompt).toContain("/Users/me/ml-projects/resnet-cifar")
    expect(prompt).toContain("wandb")
    expect(prompt).toContain("resnet-cifar")
    expect(prompt).toContain("abc123def")
    expect(prompt).toContain("val_loss")
    expect(prompt).toContain("5 total")
    expect(prompt).toContain("2 active")
    expect(prompt).toContain("Budget remaining")
    expect(prompt).toContain("7.5")
    expect(prompt).toContain("12")
  })

  it("appends the version tag as an invisible comment", () => {
    const prompt = buildAgentSystemPrompt("debugger", buildEmptyContext())
    // Version comment must be present and tagged with the current version.
    expect(prompt).toContain(`[prompt:${SYSTEM_PROMPT_VERSION}]`)
    // The comment must be the last line so it doesn't pollute the
    // visible prompt body.
    expect(prompt.trimEnd().endsWith(`[prompt:${SYSTEM_PROMPT_VERSION}]`)).toBe(true)
  })

  it("every mode has non-empty instructions", () => {
    const roles: AgentRole[] = [
      "debugger",
      "scaffolder",
      "planner",
      "researcher",
      "critic",
    ]
    for (const role of roles) {
      expect(MODE_INSTRUCTIONS[role].length).toBeGreaterThan(100)
    }
  })

  it("does not emit Known dead ends when project memory is empty", () => {
    const ctx: PromptContext = {
      ...buildEmptyContext(),
      projectMemory: { deadEnds: [], insights: [] },
    }

    const prompt = buildAgentSystemPrompt("debugger", ctx)

    expect(prompt.toLowerCase()).not.toContain("known dead ends")
  })

  it("emits Known dead ends when project memory has at least one entry", () => {
    const ctx: PromptContext = {
      ...buildEmptyContext(),
      projectMemory: {
        deadEnds: [
          {
            label: "batch_size=256 improves throughput",
            evidence: "OOM at step 100, 3 consecutive failures",
            marker: "2026-08-12",
          },
        ],
        insights: [],
      },
    }

    const prompt = buildAgentSystemPrompt("debugger", ctx)

    expect(prompt).toContain("Known dead ends")
    expect(prompt).toContain("batch_size=256")
  })

  it("emits Project insights when project memory has at least one entry", () => {
    const ctx: PromptContext = {
      ...buildEmptyContext(),
      projectMemory: {
        deadEnds: [],
        insights: [
          {
            label: "lr=5e-4 works best for ResNet50 on CIFAR-10",
            evidence: "run b4c8f30 val_loss=0.28, best of 4 runs",
            marker: "High",
          },
        ],
      },
    }

    const prompt = buildAgentSystemPrompt("debugger", ctx)

    expect(prompt).toContain("Project insights")
    expect(prompt).toContain("lr=5e-4")
  })

  it("render is deterministic for a given (role, ctx) pair", () => {
    const ctx: PromptContext = buildEmptyContext()
    const first = buildAgentSystemPrompt("debugger", ctx)
    const second = buildAgentSystemPrompt("debugger", ctx)
    expect(first).toBe(second)
  })
})

describe("buildSystemPrompt (backward-compat path)", () => {
  it("delegates to buildAgentSystemPrompt and produces all four layers", () => {
    const prompt = buildSystemPrompt("debug")

    // All four layer markers should be present — the legacy chat
    // surface must produce the same structural prompt as the
    // agent loop. Note: the backward-compat path uses
    // buildEmptyContext() so selectedRunId etc. are null, but the
    // structural markers must still appear.
    expect(prompt).toContain("// Layer 1:")
    expect(prompt).toContain("// Layer 2:")
    expect(prompt).toContain("// Layer 3:")
    expect(prompt).toContain("// Layer 4:")
  })

  it("maps ModeId 'debug' to AgentRole 'debugger'", () => {
    expect(deriveRoleFromMode("debug")).toBe("debugger")
  })

  it("maps ModeId 'scaffold' to AgentRole 'scaffolder'", () => {
    expect(deriveRoleFromMode("scaffold")).toBe("scaffolder")
  })

  it("maps ModeId 'plan' to AgentRole 'planner'", () => {
    expect(deriveRoleFromMode("plan")).toBe("planner")
  })

  it("maps ModeId 'research' to AgentRole 'researcher'", () => {
    expect(deriveRoleFromMode("research")).toBe("researcher")
  })

  it("maps ModeId 'multitask' to the closest active role (researcher)", () => {
    expect(deriveRoleFromMode("multitask")).toBe("researcher")
  })

  it("prompt includes mode-specific content for each ModeId", () => {
    const debugPrompt = buildSystemPrompt("debug")
    const scaffoldPrompt = buildSystemPrompt("scaffold")
    const planPrompt = buildSystemPrompt("plan")
    const researchPrompt = buildSystemPrompt("research")

    // Each ModeId produces a different Layer 3 body (different role).
    expect(debugPrompt).not.toBe(scaffoldPrompt)
    expect(scaffoldPrompt).not.toBe(planPrompt)
    expect(planPrompt).not.toBe(researchPrompt)
  })
})

describe("systemPrompt — truncation behaviour", () => {
  it("truncates Layer 4 to ~5K chars when project memory is huge", () => {
    const hugeDeadEnds = Array.from({ length: 200 }, (_, i) => ({
      label: `dead-end ${i}: lr tuning failed with config ${i}`,
      evidence: `run_id=${i.toString().padStart(4, "0")} val_loss plateau at step 5000`,
      marker: "2026-08-12",
    }))
    const hugeInsights = Array.from({ length: 200 }, (_, i) => ({
      label: `insight ${i}: best config from sweep`,
      evidence: `run_id=${(i + 1000).toString().padStart(4, "0")}`,
      marker: "Medium",
    }))

    const ctx: PromptContext = {
      ...buildEmptyContext(),
      projectMemory: { deadEnds: hugeDeadEnds, insights: hugeInsights },
    }

    const prompt = buildAgentSystemPrompt("debugger", ctx)

    // Extract just Layer 4 (after the "CONTEXT INJECTION" marker).
    const layer4Start = prompt.indexOf("CONTEXT INJECTION")
    expect(layer4Start).toBeGreaterThanOrEqual(0)
    const layer4End = prompt.indexOf("[prompt:1.2.0]")
    const layer4 = prompt.slice(layer4Start, layer4End)

    // The truncation kicks in when the context body exceeds 5K chars.
    // Layer 4 includes the "CONTEXT INJECTION\n" prefix and a
    // trailing "\n\n" from the join between layers. Use `trimEnd()`
    // to inspect the actual body.
    expect(layer4.trimEnd().length).toBeLessThanOrEqual(5_022)
    expect(layer4.trimEnd().endsWith("...")).toBe(true)
  })
})
