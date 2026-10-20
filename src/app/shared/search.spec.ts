import { matchesSearch } from './search';

describe('matchesSearch', () => {
  it('matches everything when the search is empty or only spaces', () => {
    expect(matchesSearch('', 'Greeting', 'Hello there.')).toBe(true);
    expect(matchesSearch('   ', 'Greeting', 'Hello there.')).toBe(true);
  });

  it('finds the search in any of the texts, ignoring case and spaces around it', () => {
    expect(matchesSearch(' GREET ', 'Greeting', 'Hello there.')).toBe(true);
    expect(matchesSearch('there', 'Greeting', 'Hello there.')).toBe(true);
  });

  it('does not match a search found in none of the texts', () => {
    expect(matchesSearch('bye', 'Greeting', 'Hello there.')).toBe(false);
  });
});
