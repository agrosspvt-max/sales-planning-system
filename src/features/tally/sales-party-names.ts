/** Exact source-name attribution shared by sales publication and bill drilldown. */
export function salesPartyNames(
  dealers: { id: string; name: string }[],
  aliases: { tallyName: string; systemDealerId: string }[],
  companyActuals: boolean,
) {
  const needed = new Set(dealers.map((dealer) => dealer.id));
  const candidates = new Map<string, Set<string>>();
  const add = (name: string, id: string) => {
    const set = candidates.get(name) ?? new Set<string>();
    set.add(id);
    candidates.set(name, set);
  };
  for (const alias of aliases) add(alias.tallyName.trim(), alias.systemDealerId);
  const aliasOwners = new Set(aliases.map((alias) => alias.systemDealerId));
  const configured = new Set(candidates.keys());
  for (const dealer of dealers) {
    const name = dealer.name.trim();
    if (companyActuals ? !configured.has(name) : !aliasOwners.has(dealer.id)) add(name, dealer.id);
  }
  return [...candidates]
    .filter(([, ids]) => [...ids].some((id) => needed.has(id)))
    .map(([name, ids]) => ({ name, dealerIds: [...ids].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
