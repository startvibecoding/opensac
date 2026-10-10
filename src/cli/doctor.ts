// the `doctor` subcommand and its
// human/JSON projections.

import {
  run as runDoctor,
  STATUS_ERROR,
  STATUS_OK,
  STATUS_SKIP,
  STATUS_WARN,
} from "../doctor/doctor.ts";

export interface DoctorCommandOptions {
  json: boolean;
  version: string;
  write?: (line: string) => void;
}

/** Runs the doctor diagnostics and projects the chosen output format. */
export function executeDoctorCommand(opts: DoctorCommandOptions): {
  exitCode: number;
} {
  const write = opts.write ?? ((line: string) => console.log(line));
  const result = runDoctor("", opts.version);
  if (opts.json) {
    write(JSON.stringify(result));
    return { exitCode: 0 };
  }
  write("");
  write("  OpenSAC Doctor");
  write("  ------------");
  for (const check of result.checks) {
    let line = `    ${doctorIcon(check.status)} ${check.title}`;
    if (check.detail) line += ` - ${check.detail}`;
    write(line);
  }
  write("");
  write(`  Result: ${result.summary}`);
  write("");
  return { exitCode: 0 };
}

function doctorIcon(status: string): string {
  switch (status) {
    case STATUS_OK:
      return "[ok]";
    case STATUS_WARN:
      return "[warn]";
    case STATUS_ERROR:
      return "[error]";
    case STATUS_SKIP:
      return "[skip]";
    default:
      return "[skip]";
  }
}
