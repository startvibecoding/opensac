// Shared ANSI style constants for the string-rendered TUI surfaces (header,
// dialogs, tool modal, editor, suggest, agent tab bar).
//
// These renderers build plain strings, so styling is raw SGR codes rather than
// Ink <Text> props. One owner per color: components import from here instead
// of redeclaring local constants (accent/dim were previously duplicated in
// five files). Ink components still style via props — do not import these
// into JSX.

/** Accent (spring green): active tab, selected row, logo, panel titles. */
export const ACCENT = "\u001B[38;5;86m";
/** Dim foreground: hints, secondary text, disabled rows. */
export const DIM = "\u001B[38;5;240m";
/** Bold weight. */
export const BOLD = "\u001B[1m";
/** Red: errors, validation failures, destructive states. */
export const RED = "\u001B[38;5;196m";
/** Green: success / completed states. */
export const GREEN = "\u001B[38;5;82m";
/** Orange: interrupted / warning states. */
export const ORANGE = "\u001B[38;5;214m";
/** Reset all attributes. */
export const RESET = "\u001B[0m";
