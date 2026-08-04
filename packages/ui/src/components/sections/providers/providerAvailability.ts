export const shouldLoadAvailableProviders = (isAddMode: boolean): boolean => isAddMode;

export interface ConnectableProvider {
  id: string;
  name?: string;
}

interface ConnectableProvidersInput {
  /** Providers OpenCode can describe: catalog entries plus config-defined ones. */
  catalog: ConnectableProvider[];
  /** Providers that advertise auth methods, including plugin-registered ones. */
  authProviderIds: string[];
  connectedIds: ReadonlySet<string>;
}

/**
 * Providers the user can still connect. A plugin can register auth methods for a
 * provider the catalog does not know (Cursor via its OAuth plugin), and such a
 * provider is absent from the provider list until it holds credentials, so auth
 * methods are a first-class source of connectable providers.
 */
export const listConnectableProviders = ({
  catalog,
  authProviderIds,
  connectedIds,
}: ConnectableProvidersInput): ConnectableProvider[] => {
  const byId = new Map<string, ConnectableProvider>();

  for (const provider of catalog) {
    if (connectedIds.has(provider.id) || byId.has(provider.id)) {
      continue;
    }
    byId.set(provider.id, provider);
  }

  for (const providerId of authProviderIds) {
    if (connectedIds.has(providerId) || byId.has(providerId)) {
      continue;
    }
    byId.set(providerId, { id: providerId });
  }

  return [...byId.values()].sort((a, b) => {
    const labelA = (a.name || a.id).toLowerCase();
    const labelB = (b.name || b.id).toLowerCase();
    return labelA.localeCompare(labelB);
  });
};
