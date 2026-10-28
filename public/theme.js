// the chosen theme on the page before its first paint. the app's Theme sets it only once Angular has started, and
// until then a window chosen dark on a light system (or light on a dark one) paints in the system's colours. it reads
// the raw string Theme keeps (core/settings.ts), and Theme.apply() takes over from there.
try {
  const theme = localStorage.getItem('parrot.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // storage blocked: the system's colours, as Theme would have them
}
