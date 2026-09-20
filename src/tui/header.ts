// Ported from internal/tui/header.go: the two-panel startup header — the
// ASCII logo and a rounded-border info panel (version, provider | model,
// cwd, rename notice). The Go original renders through lipgloss styles; this
// projection renders the same layout with ANSI 256-color codes so the output
// stays a plain string for Ink <Text> and for tests.

import { displayWidth, truncateDisplay } from "./formatters.ts";

export const mothxLogo = `██   ██  ███  ████ █  █ █  █
███ ███ █   █  ██  █  █  ██
█ ███ █ █   █  ██  ████  ██
█  █  █ █   █  ██  █  █ █  █
█     █  ███   ██  █  █ █  █`;

const renameNotice = "Make OSCHINA Tokens Harness eXecution";

const accent = "\u001B[38;5;86m";
const bold = "\u001B[1m";
const reset = "\u001B[0m";

/** Width in display cells of the widest logo line. */
export function logoWidth(): number {
  return Math.max(...mothxLogo.split("\n").map(displayWidth));
}

/** Wraps each line in a rounded border sized to the widest line. */
function roundedBox(content: string): string {
  const lines = content.split("\n");
  const inner = Math.max(...lines.map(displayWidth));
  const top = `╭${"─".repeat(inner + 2)}╮`;
  const bottom = `╰${"─".repeat(inner + 2)}╯`;
  const padded = lines.map((l) => {
    // padEnd counts UTF-16 units, not display cells
    const pad = " ".repeat(inner - displayWidth(l));
    return `│ ${l}${pad} │`;
  });
  return [top, ...padded, bottom].join("\n");
}

/**
 * Renders the header. At full width the logo (vertically centered against the
 * info panel) sits left of the info panel with a 2-cell gap; below that
 * threshold only the info panel renders, padded to width-2. The cwd line is
 * truncated when the panel would overflow (Go renderHeader).
 */
export function renderHeader(
  width: number,
  version: string,
  providerName: string,
  modelName: string,
  cwd: string,
): string {
  const logoW = logoWidth();

  const line1 = `${bold}MothX (${version})${reset}`;
  const line2 = `${providerName} | ${modelName}`;
  const line3 = cwd;
  const infoContent = [line1, line2, line3, renameNotice].join("\n");
  let infoPanel = roundedBox(infoContent);
  const infoW = displayWidth(infoPanel.split("\n")[0]);

  const gap = 2;
  if (width < logoW + infoW + gap + 2) {
    // Responsive: show info panel only at full width
    return roundedBox(
      [
        line1,
        line2,
        truncateDisplay(line3, Math.max(width - 6, 0)),
        renameNotice,
      ].join("\n"),
    );
  }

  // Truncate cwd to fit
  const available = width - logoW - gap - 4; // border chars
  if (displayWidth(line3) > available && available > 3) {
    const truncated = truncateDisplay(cwd, available);
    infoPanel = roundedBox(
      [line1, line2, truncated, renameNotice].join("\n"),
    );
  }

  const panelLines = infoPanel.split("\n");
  const panelH = panelLines.length;
  const logoLines = mothxLogo.split("\n");
  const logoPad = Math.max(0, Math.floor((panelH - logoLines.length) / 2));
  const logoBlock: string[] = [];
  for (let i = 0; i < panelH; i++) {
    logoBlock.push(
      i >= logoPad && i < logoPad + logoLines.length
        ? `${accent}${logoLines[i - logoPad]}${reset}`
        : "",
    );
  }
  const logoColWidth = Math.max(...logoBlock.map(displayWidth)) + gap;
  const joined = logoBlock.map((logoLine, i) => {
    const logoPadCells = " ".repeat(logoColWidth - displayWidth(logoLine));
    return `${logoLine}${logoPadCells}${panelLines[i]}`;
  });
  return joined.join("\n");
}
