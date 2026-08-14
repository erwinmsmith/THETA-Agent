import {
  configureInferenceSettings,
  getInferenceSettingsView,
  listInferenceProviders,
  resetInferenceSelection,
  resolveInferenceSelection,
  selectInferenceModel,
} from '@theta-agent/tools/support/providers/registry.js';
import type { InferenceSettingsUpdate } from '@theta-agent/tools/support/providers/settings.js';

export type ModelSelectionAction =
  | { action: 'list' | 'current' | 'reset' }
  | { action: 'use'; providerId: string; model: string };

export class ModelSelectionService {
  settings(): unknown {
    return getInferenceSettingsView();
  }

  configure(input: InferenceSettingsUpdate & {
    llm?: InferenceSettingsUpdate['llm'] & { model?: string };
  }): unknown {
    return configureInferenceSettings(input);
  }

  execute(input: ModelSelectionAction): unknown {
    if (input.action === 'use') {
      const selection = selectInferenceModel(input.providerId, input.model);
      return {
        kind: 'inference.model.selected',
        selection,
        message: `Using ${selection.providerId}/${selection.model}.`,
      };
    }
    if (input.action === 'reset') {
      const selection = resetInferenceSelection();
      return {
        kind: 'inference.model.reset',
        selection: selection ?? null,
        message: selection
          ? `Saved selection cleared; using ${selection.providerId}/${selection.model}.`
          : 'Saved selection cleared; deterministic fallback is active.',
      };
    }
    if (input.action === 'list') {
      return {
        kind: 'inference.provider.list',
        providers: listInferenceProviders(),
        selection: resolveInferenceSelection() ?? null,
      };
    }
    const selection = resolveInferenceSelection();
    return {
      kind: 'inference.model.current',
      selection: selection ?? null,
      deterministicFallback: selection === undefined,
    };
  }
}
