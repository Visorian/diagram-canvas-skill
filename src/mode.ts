// Diagrams embedded by `canvas.js export` as JSON, for a published read-only page.
export const embedded = document.getElementById("diagram-data")?.textContent ?? undefined;

// Read-only: the viewer build (`vite build --mode viewer`), where files are opened in the browser,
// or an exported page. Nothing is written.
export const readOnly = import.meta.env.MODE === "viewer" || embedded !== undefined;
