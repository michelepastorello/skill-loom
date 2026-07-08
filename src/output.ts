const useColor =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(code: string): (s: string) => string {
  return (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const green = paint("32");
export const red = paint("31");
export const yellow = paint("33");
export const dim = paint("2");

export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.length);
    });
  return rows
    .map((r) =>
      r
        .map((c, i) => c.padEnd(widths[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
