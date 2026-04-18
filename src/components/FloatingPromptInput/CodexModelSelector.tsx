import React from "react";
import { ChevronUp, Check, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  getCachedCodexModelNames,
  CODEX_MODEL_NAMES_UPDATED_EVENT,
} from "@/lib/modelNameParser";

/**
 * Codex model configuration
 */
export interface CodexModelConfig {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  isDefault?: boolean;
}

/**
 * Default Codex models used as fallback when no cached data is available.
 * Intentionally kept as the known baseline; dynamically discovered models
 * from stream init messages will merge/override these.
 * Updated: March 2026
 */
const DEFAULT_CODEX_MODELS: CodexModelConfig[] = [
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    description: '最强旗舰模型，1M 上下文，支持 /fast（2026年3月）',
    icon: <Star className="h-4 w-4 text-purple-500" />,
    isDefault: true,
  },
];

/**
 * Build the Codex model list by applying cached display names to defaults.
 */
export function getCodexModels(): CodexModelConfig[] {
  const cached = getCachedCodexModelNames();

  return DEFAULT_CODEX_MODELS.map((model) =>
    cached[model.id] ? { ...model, name: cached[model.id] } : model
  );
}

/**
 * Static export for backward compatibility.
 * Prefer using getCodexModels() for dynamic names.
 */
export const CODEX_MODELS: CodexModelConfig[] = getCodexModels();

interface CodexModelSelectorProps {
  selectedModel: string | undefined;
  onModelChange: (model: string) => void;
  disabled?: boolean;
  availableModels?: CodexModelConfig[];
}

/**
 * CodexModelSelector component - Dropdown for selecting Codex model.
 * Supports dynamic model discovery via localStorage cache and custom events,
 * following the same pattern as Claude's ModelSelector.
 */
export const CodexModelSelector: React.FC<CodexModelSelectorProps> = ({
  selectedModel,
  onModelChange,
  disabled = false,
  availableModels: availableModelsProp,
}) => {
  const [open, setOpen] = React.useState(false);
  const [dynamicModels, setDynamicModels] = React.useState<CodexModelConfig[]>(() => getCodexModels());

  // Listen for Codex model name updates from stream init messages
  React.useEffect(() => {
    const handleUpdate = () => {
      setDynamicModels(getCodexModels());
    };

    window.addEventListener(CODEX_MODEL_NAMES_UPDATED_EVENT, handleUpdate);
    return () => {
      window.removeEventListener(CODEX_MODEL_NAMES_UPDATED_EVENT, handleUpdate);
    };
  }, []);

  // Allow prop override (same pattern as Claude's ModelSelector)
  const models = availableModelsProp || dynamicModels;

  // Find selected model or default
  const selectedModelData = models.find(m => m.id === selectedModel)
    || models.find(m => m.isDefault)
    || models[0];

  return (
    <Popover
      trigger={
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-8 gap-2 min-w-[160px] justify-start border-border/50 bg-background/50 hover:bg-accent/50"
        >
          {selectedModelData.icon}
          <span className="flex-1 text-left">{selectedModelData.name}</span>
          {selectedModelData.isDefault && (
            <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />
          )}
          <ChevronUp className="h-4 w-4 opacity-50" />
        </Button>
      }
      content={
        <div className="w-[320px] p-1">
          <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border/50 mb-1">
            Select Codex Model
          </div>
          {models.map((model) => {
            const isSelected = selectedModel === model.id ||
              (!selectedModel && model.isDefault);
            return (
              <button
                key={model.id}
                onClick={() => {
                  onModelChange(model.id);
                  setOpen(false);
                }}
                className={cn(
                  "w-full flex items-start gap-3 p-3 rounded-md transition-colors text-left group",
                  "hover:bg-accent",
                  isSelected && "bg-accent"
                )}
              >
                <div className="mt-0.5">{model.icon}</div>
                <div className="flex-1 space-y-1">
                  <div className="font-medium text-sm flex items-center gap-2">
                    {model.name}
                    {isSelected && (
                      <Check className="h-3.5 w-3.5 text-primary" />
                    )}
                    {model.isDefault && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                        Default
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {model.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      }
      open={open}
      onOpenChange={setOpen}
      align="start"
      side="top"
    />
  );
};
