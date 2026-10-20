/** Whether any of the texts contains the search, ignoring case and spaces around it; an empty search matches all. */
export function matchesSearch(search: string, ...texts: string[]) {
  const wanted = search.trim().toLowerCase();
  return !wanted || texts.some((text) => text.toLowerCase().includes(wanted));
}
