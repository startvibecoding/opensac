// wires the slash-command spec
// table into the suggestion dropdown. Command-name suggestions come from the
// specs; per-command argument suggestions come from the static argument
// tables below. The App-level overlays (auth dialog, tool modal, …) simply
// suppress suggestions; that decision stays in the App slice.

import { Translator } from "./i18n.ts";
import { commandSpecs } from "./command_specs.ts";
import { Suggest, type SuggestItem } from "./components/suggest/suggest.ts";
import { splitFields } from "./command_specs.ts";

/** Builds suggestion items from the command spec table. */
export function commandSuggestionItems(
  tr: Translator = new Translator("en"),
): SuggestItem[] {
  return commandSpecs.map((spec) => ({
    label: spec.name,
    value: spec.value,
    description: tr.text(spec.description),
  }));
}

/**
 * Suggestion state for one input value: the item list, the filter query, and
 * whether suggestions apply at all. Suggestions activate when the value
 * starts with "/" and has no newline: before the first space they suggest
 * command names, after it they suggest the command's known arguments.
 */
export function commandSuggestionItemsForInput(
  value: string,
  tr: Translator = new Translator("en"),
): { items: SuggestItem[]; query: string } | undefined {
  if (!value.startsWith("/") || value.includes("\n")) {
    return undefined;
  }
  if (!/[ \t]/.test(value)) {
    return { items: commandSuggestionItems(tr), query: value };
  }
  const items = commandArgumentSuggestionItems(value);
  if (items.length === 0) return undefined;
  return { items, query: value };
}

/** Static per-command argument tables (Go commandArgumentSuggestionItems). */
export function commandArgumentSuggestionItems(value: string): SuggestItem[] {
  const fields = splitFields(value);
  if (fields.length === 0) return [];
  const cmd = fields[0];
  let argIndex = fields.length - 1;
  if (/[ \t]$/.test(value)) argIndex = fields.length;
  if (argIndex < 1) argIndex = 1;

  switch (cmd) {
    case "/esm":
      if (argIndex === 1) {
        return argumentItems(cmd, [
          "edit",
          "pause",
          "resume",
          "clear",
          "guide",
        ]);
      }
      break;
    case "/mode":
      if (argIndex === 1) {
        return argumentItems(cmd, ["plan", "agent", "yolo", "os"]);
      }
      break;
    case "/defaultModel":
      if (argIndex === 1) {
        return argumentItems(cmd, ["project", "global"]);
      }
      break;
    case "/sessions":
      if (argIndex === 1) {
        return argumentItems(cmd, ["ls", "set", "clear", "del"]);
      }
      break;
    case "/expert":
      if (argIndex === 1) {
        return argumentItems(cmd, ["list", "show", "bind", "unbind", "switch"]);
      }
      break;
    case "/delegate":
      if (argIndex === 1) {
        return argumentItems(cmd, ["on", "off", "status"]);
      }
      break;
    case "/browser":
      if (argIndex === 1) {
        return argumentItems(cmd, ["on", "off", "status"]);
      }
      break;
    case "/stats":
      if (argIndex === 1) {
        return argumentItems(cmd, ["server", "stop-server", "tui"]);
      }
      break;
    case "/alloweditpath":
      if (argIndex === 1) {
        return argumentItems(cmd, ["add", "remove", "clear"]);
      }
      break;
    case "/allowautoedit":
      if (argIndex === 1) {
        return argumentItems(cmd, ["on", "off"]);
      }
      if (
        argIndex === 2 &&
        fields.length >= 2 &&
        (fields[1] === "on" || fields[1] === "off")
      ) {
        return argumentItems(`${cmd} ${fields[1]}`, ["global"]);
      }
      break;
    case "/statusline":
      if (argIndex === 1) {
        return argumentItems(cmd, [
          "status",
          "on",
          "off",
          "command",
          "refresh",
        ]);
      }
      if (
        argIndex === 2 &&
        fields.length >= 2 &&
        (fields[1] === "on" || fields[1] === "off")
      ) {
        return argumentItems(`${cmd} ${fields[1]}`, ["project", "global"]);
      }
      break;
    case "/tuilang":
      if (argIndex === 1) {
        return argumentItems(cmd, ["global", "project", "auto", "zh", "en"]);
      }
      if (
        argIndex === 2 &&
        fields.length >= 2 &&
        (fields[1] === "global" || fields[1] === "project")
      ) {
        return argumentItems(`${cmd} ${fields[1]}`, ["auto", "zh", "en"]);
      }
      break;
    case "/agent":
      if (argIndex === 1) {
        return argumentItems(cmd, ["list", "switch", "destroy"]);
      }
      break;
  }
  return [];
}

function argumentItems(prefix: string, args: string[]): SuggestItem[] {
  return args.map((arg) => {
    const value = `${prefix} ${arg}`;
    return { label: value, value };
  });
}

export { Suggest };
