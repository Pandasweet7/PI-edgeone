export function parseTerminalSize(cols, rows) {
    const parsedCols = Number(cols);
    const parsedRows = Number(rows);
    if (!isValidTerminalSize(parsedCols, parsedRows))
        return undefined;
    return { cols: Math.floor(parsedCols), rows: Math.floor(parsedRows) };
}
export function terminalSizeQuery(cols, rows) {
    const size = parseTerminalSize(cols, rows);
    if (size === undefined)
        return "";
    return `?cols=${encodeURIComponent(String(size.cols))}&rows=${encodeURIComponent(String(size.rows))}`;
}
export function isValidTerminalSize(cols, rows) {
    return Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0;
}
//# sourceMappingURL=terminalSize.js.map