/**
 * Pure derivations for the composer model picker.
 *
 * Kept free of React so they can be tested directly; `useModelPickerData`
 * only memoizes calls into these.
 */

import type {
    ModelPickerEngineOption,
    ModelPickerLabels,
    ModelPickerProvider,
} from '@/components/model-picker/ModelPickerList';
import type { EngineCatalog, EngineCatalogModel, HarnessId, HarnessRuntimeStatus } from '@/types/harness';
import type { I18nContextValue } from '@/lib/i18n/react-context';

type Translate = I18nContextValue['t'];

export const ENGINE_STATUS_LABEL_KEYS: Record<
    HarnessRuntimeStatus,
    | 'settings.engines.sidebar.status.ready'
    | 'settings.engines.sidebar.status.needsLogin'
    | 'settings.engines.sidebar.status.missingCli'
    | 'settings.engines.sidebar.status.unsupportedHost'
    | 'settings.engines.sidebar.status.error'
> = {
    ready: 'settings.engines.sidebar.status.ready',
    'needs-login': 'settings.engines.sidebar.status.needsLogin',
    'missing-cli': 'settings.engines.sidebar.status.missingCli',
    'unsupported-host': 'settings.engines.sidebar.status.unsupportedHost',
    error: 'settings.engines.sidebar.status.error',
};

export function buildModelPickerLabels(t: Translate): ModelPickerLabels {
    return {
        searchPlaceholder: t('chat.modelControls.searchModels'),
        noResults: t('chat.modelControls.noModelsFound'),
        favorites: t('chat.modelControls.favorites'),
        recent: t('chat.modelControls.recent'),
        keyboardHint: t('chat.modelControls.keyboardHintNavigate'),
        favorite: t('chat.modelControls.favoriteAria'),
        unfavorite: t('chat.modelControls.unfavoriteAria'),
        capabilities: t('chat.modelControls.capabilities'),
        capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
        capabilityReasoning: t('chat.modelControls.capability.reasoning'),
        input: t('chat.modelControls.input'),
        output: t('chat.modelControls.output'),
        context: t('chat.modelControls.context'),
        costPerMillion: t('chat.modelControls.costPerMillion'),
        costInOutShort: t('chat.modelControls.costInOutShort'),
        modalityText: t('chat.modelControls.modality.text'),
        modalityImage: t('chat.modelControls.modality.image'),
        modalityVideo: t('chat.modelControls.modality.video'),
        modalityAudio: t('chat.modelControls.modality.audio'),
        modalityPdf: t('chat.modelControls.modality.pdf'),
        engines: t('chat.engines.section'),
    };
}

/**
 * Claude only appears when the engine is enabled in settings; its status label
 * falls back to "loading" until the catalog resolves, so the picker never
 * implies Claude is ready before detection has answered.
 */
export function buildEngineOptions(args: {
    t: Translate;
    pickerHarnessId: HarnessId;
    enginesClaudeCodeEnabled: boolean;
    claudeCatalog: EngineCatalog | null | undefined;
}): ModelPickerEngineOption[] {
    const { t, pickerHarnessId, enginesClaudeCodeEnabled, claudeCatalog } = args;
    const options: ModelPickerEngineOption[] = [{
        id: 'opencode',
        name: t('chat.engines.opencode'),
        selected: pickerHarnessId === 'opencode',
    }];
    if (enginesClaudeCodeEnabled) {
        options.push({
            id: 'claude-code',
            name: t('chat.engines.claudeCode'),
            statusLabel: claudeCatalog
                ? t(ENGINE_STATUS_LABEL_KEYS[claudeCatalog.status])
                : t('settings.engines.sidebar.status.loading'),
            selected: pickerHarnessId === 'claude-code',
        });
    }
    return options;
}

export function buildPickerProviders(args: {
    t: Translate;
    pickerHarnessId: HarnessId;
    claudePickerProviderId: string;
    claudeCatalogModels: readonly EngineCatalogModel[];
    providers: unknown[];
}): ModelPickerProvider[] {
    const { t, pickerHarnessId, claudePickerProviderId, claudeCatalogModels, providers } = args;
    if (pickerHarnessId !== 'claude-code') {
        return providers as ModelPickerProvider[];
    }
    return [{
        id: claudePickerProviderId,
        name: t('chat.engines.claudeCode'),
        models: claudeCatalogModels.map((model) => ({
            id: model.id,
            name: model.name,
            limit: model.limit,
            modalities: model.modalities,
            reasoning: model.reasoning,
            tool_call: model.toolCall,
        })),
    }];
}

export function selectPickerModel(args: {
    pickerHarnessId: HarnessId;
    claudePickerProviderId: string;
    claudeModelRef: string;
    currentProviderId: string | null | undefined;
    currentModelId: string | null | undefined;
}): { providerID: string; modelID: string } | null {
    const { pickerHarnessId, claudePickerProviderId, claudeModelRef, currentProviderId, currentModelId } = args;
    if (pickerHarnessId === 'claude-code') {
        return { providerID: claudePickerProviderId, modelID: claudeModelRef };
    }
    return currentProviderId && currentModelId
        ? { providerID: currentProviderId, modelID: currentModelId }
        : null;
}
