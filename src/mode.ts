// `vite build --mode viewer` builds the read-only viewer: files are opened in the browser, never written.
export const readOnly = import.meta.env.MODE === "viewer";
