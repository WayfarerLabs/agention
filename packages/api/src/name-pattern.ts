// Agent, session and topic names: 1 to 63 lowercase ASCII letters, digits,
// hyphens and underscores, starting with a letter or digit. Names appear
// unescaped in URL paths and directory names, so the grammar admits nothing
// that needs escaping in either.
//
// This module imports nothing, so it has its own entry point, which the web
// UI's service worker loads without the schemas and Zod.
export const nameBody = "[a-z0-9][a-z0-9_-]{0,62}";
export const namePattern = new RegExp(`^${nameBody}$`);
