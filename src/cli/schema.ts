// The theme schema is the format's executable contract. The CLI validates third-party themes
// against it in full; the runtime stays lenient (warnings only) so a broken theme can never keep
// ZCode from starting — the runtime's hard line is the value grammar in shared/css.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

let problemsOf: ((manifest: unknown) => string[]) | undefined;

/** Schema problems of a theme.json, e.g. `wallpaper/fit must be equal to one of the allowed values`. */
export function themeSchemaProblems(packageRoot: string, manifest: unknown): string[] {
  problemsOf ??= load(packageRoot);
  return problemsOf(manifest);
}

function load(packageRoot: string): (manifest: unknown) => string[] {
  const schema = JSON.parse(readFileSync(join(packageRoot, "schema", "theme.schema.json"), "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  return (manifest: unknown) => {
    if (validate(manifest)) return [];
    return (validate.errors ?? []).map((error) =>
      error.instancePath ? `${error.instancePath} ${error.message ?? "is invalid"}` : (error.message ?? "is invalid"),
    );
  };
}
