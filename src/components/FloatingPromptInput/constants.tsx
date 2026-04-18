import { Sparkles } from "lucide-react";
import { ModelConfig, ThinkingModeConfig } from "./types";

/**
 * Get available models with dynamically updated display names.
 */
export function getModels(): ModelConfig[] {
  return [
    {
      id: "opus47",
      name: "Claude Opus 4.7",
      description: "Locked to Claude Opus 4.7 (claude-opus-4-7)",
      icon: <Sparkles className="h-4 w-4" />
    }
  ];
}

/**
 * Static model list for backward compatibility.
 * Prefer using getModels() for dynamic names.
 */
export const MODELS: ModelConfig[] = getModels();

/**
 * Thinking modes configuration
 * Claude 4.6 Adaptive Thinking with effort levels
 * Controls thinking depth via CLAUDE_CODE_THINKING_EFFORT env var
 *
 * Note: Names and descriptions are translation keys that will be resolved at runtime
 */
export const THINKING_MODES: ThinkingModeConfig[] = [
  {
    id: "off",
    name: "promptInput.thinkingModeOff",
    description: "promptInput.normalSpeed",
    level: 0,
  },
  {
    id: "adaptive",
    effort: "low",
    name: "promptInput.thinkingEffortLow",
    description: "promptInput.thinkingEffortLowDesc",
    level: 1,
  },
  {
    id: "adaptive",
    effort: "medium",
    name: "promptInput.thinkingEffortMedium",
    description: "promptInput.thinkingEffortMediumDesc",
    level: 2,
  },
  {
    id: "adaptive",
    effort: "high",
    name: "promptInput.thinkingEffortHigh",
    description: "promptInput.thinkingEffortHighDesc",
    level: 3,
  },
  {
    id: "adaptive",
    effort: "max",
    name: "promptInput.thinkingEffortMax",
    description: "promptInput.thinkingEffortMaxDesc",
    level: 4,
  }
];
