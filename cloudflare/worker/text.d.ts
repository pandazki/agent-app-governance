// Files the Worker bundles as text (the `rules` in wrangler.jsonc).
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*/bin/appgov.mjs" {
  const text: string;
  export default text;
}
