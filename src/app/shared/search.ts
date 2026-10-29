/** Whether any of the texts contains the search, ignoring case, spaces around it and how its letters are written ("café"
 * with its é as one character or as e and a mark); an empty search matches all. */
export function matchesSearch(search: string, ...texts: string[]) {
  const wanted = search.trim().normalize('NFC').toLowerCase();
  return !wanted || texts.some((text) => text.normalize('NFC').toLowerCase().includes(wanted));
}
