/**
 * Memoized derivations for the composer model picker.
 *
 * These were previously rebuilt inside `renderModelSelector()` on every render
 * of ModelControls — including a 21-call translation object and a full remap of
 * the Claude catalog — which runs on each keystroke in the composer.
 */

import React from 'react';
import type {
    ModelPickerEngineOption,
    ModelPickerLabels,
    ModelPickerProvider,
} from '@/components/model-picker/ModelPickerList';
import type { EngineCatalog, EngineCatalogModel, HarnessId } from '@/types/harness';
import type { I18nContextValue } from '@/lib/i18n/react-context';
import {
    buildEngineOptions,
    buildModelPickerLabels,
    buildPickerProviders,
    selectPickerModel,
} from './modelPickerData';

/** Minimal shape of a favorites/recents entry that this module needs. */
type TargetListEntry = { target: { harnessId: HarnessId } };

export type ModelPickerData<TEntry extends TargetListEntry> = {
    labels: ModelPickerLabels;
    engineOptions: ModelPickerEngineOption[];
    pickerProviders: ModelPickerProvider[];
    pickerFavoriteModels: TEntry[];
    pickerRecentModels: TEntry[];
    pickerSelectedModel: { providerID: string; modelID: string } | null;
};

export type UseModelPickerDataArgs<TEntry extends TargetListEntry> = {
    t: I18nContextValue['t'];
    claudePickerProviderId: string;
    pickerHarnessId: HarnessId;
    enginesClaudeCodeEnabled: boolean;
    claudeCatalog: EngineCatalog | null | undefined;
    claudeCatalogModels: readonly EngineCatalogModel[];
    claudeModelRef: string;
    providers: unknown[];
    favoriteModelsList: TEntry[];
    recentModelsList: TEntry[];
    currentProviderId: string | null | undefined;
    currentModelId: string | null | undefined;
};

export function useModelPickerData<TEntry extends TargetListEntry>(
    args: UseModelPickerDataArgs<TEntry>,
): ModelPickerData<TEntry> {
    const {
        t,
        claudePickerProviderId,
        pickerHarnessId,
        enginesClaudeCodeEnabled,
        claudeCatalog,
        claudeCatalogModels,
        claudeModelRef,
        providers,
        favoriteModelsList,
        recentModelsList,
        currentProviderId,
        currentModelId,
    } = args;

    const labels = React.useMemo(() => buildModelPickerLabels(t), [t]);

    const engineOptions = React.useMemo(
        () => buildEngineOptions({ t, pickerHarnessId, enginesClaudeCodeEnabled, claudeCatalog }),
        [claudeCatalog, enginesClaudeCodeEnabled, pickerHarnessId, t],
    );

    const pickerProviders = React.useMemo(
        () => buildPickerProviders({
            t,
            pickerHarnessId,
            claudePickerProviderId,
            claudeCatalogModels,
            providers,
        }),
        [claudeCatalogModels, claudePickerProviderId, pickerHarnessId, providers, t],
    );

    const pickerFavoriteModels = React.useMemo(
        () => favoriteModelsList.filter((entry) => entry.target.harnessId === pickerHarnessId),
        [favoriteModelsList, pickerHarnessId],
    );
    const pickerRecentModels = React.useMemo(
        () => recentModelsList.filter((entry) => entry.target.harnessId === pickerHarnessId),
        [recentModelsList, pickerHarnessId],
    );

    const pickerSelectedModel = React.useMemo(
        () => selectPickerModel({
            pickerHarnessId,
            claudePickerProviderId,
            claudeModelRef,
            currentProviderId,
            currentModelId,
        }),
        [claudeModelRef, claudePickerProviderId, currentModelId, currentProviderId, pickerHarnessId],
    );

    return {
        labels,
        engineOptions,
        pickerProviders,
        pickerFavoriteModels,
        pickerRecentModels,
        pickerSelectedModel,
    };
}
