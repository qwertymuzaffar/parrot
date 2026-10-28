// public/theme.js read as text by its spec (with { loader: 'text' })
declare module '*/public/theme.js' {
  const source: string;
  export default source;
}
