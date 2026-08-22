/**
 * UTF-8 CSV for spreadsheet downloads.
 *
 * Cells that begin with a spreadsheet formula marker are prefixed with an
 * apostrophe. Product names and customer notes are database content, not code;
 * opening an export must never execute them as formulas.
 */
export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@\t\r\n\uFF0B\uFF0D\uFF1D\uFF20]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvDocument(rows: readonly (readonly unknown[])[]): string {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function csvResponse(filename: string, rows: readonly (readonly unknown[])[]) {
  const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(csvDocument(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
