/**
 * Pure layout logic for SQL tagged-template literals.
 *
 * The oxlint rules in `./plugin.ts` are thin adapters over
 * {@link checkSqlTemplate}; all behaviour is unit-testable from here.
 */
import { format as formatSql, type SqlLanguage } from "sql-formatter";

/** A tagged template split into its literal chunks and interpolations. */
export interface SqlTemplateSource {
  /** Raw text of each literal chunk (`quasis[i].value.raw`). */
  readonly quasis: ReadonlyArray<string>;
  /** Source text of each `${...}` interpolation, without the delimiters. */
  readonly expressions: ReadonlyArray<string>;
  /** Indentation of the line the tagged template starts on. */
  readonly baseIndent: string;
}

export interface SqlTemplateOptions {
  /** Leave templates that contain no newline untouched. */
  readonly allowSingleLine: boolean;
  /** Dialect passed to `sql-formatter` when {@link formatBody} is set. */
  readonly dialect: SqlLanguage;
  /** Width above which `sql-formatter` breaks a parenthesised expression. */
  readonly expressionWidth: number;
  /** Reformat the statement itself with `sql-formatter`. */
  readonly formatBody: boolean;
  /** Spaces added to {@link SqlTemplateSource.baseIndent} for the body. */
  readonly indentWidth: number;
}

export const defaultOptions: SqlTemplateOptions = {
  allowSingleLine: true,
  dialect: "postgresql",
  expressionWidth: 68,
  formatBody: false,
  indentWidth: 2,
};

export type SqlTemplateCheck =
  | { readonly kind: "ok" }
  | {
      readonly kind: "violation";
      /** Raw text the template body should be replaced with. */
      readonly expected: string;
    };

const placeholderPrefix = "oxsql_param_";

const placeholderFor = (index: number): string =>
  `${placeholderPrefix}${index}`;

const interleave = (
  quasis: ReadonlyArray<string>,
  expressions: ReadonlyArray<string>,
  render: (index: number) => string,
): string => {
  let out = quasis[0] ?? "";
  for (let index = 0; index < expressions.length; index++) {
    out += render(index) + (quasis[index + 1] ?? "");
  }
  return out;
};

/** Reassembles the raw text between the backticks, interpolations included. */
export const rawTemplateText = (source: SqlTemplateSource): string =>
  interleave(
    source.quasis,
    source.expressions,
    (index) => `\${${source.expressions[index] ?? ""}}`,
  );

const indentOf = (line: string): number =>
  (/^[ \t]*/.exec(line)?.[0] ?? "").length;

const isBlank = (line: string): boolean => line.trim() === "";

/**
 * Strips a template's existing indentation, preserving relative indentation.
 *
 * The first line is special-cased: a statement that starts on the same line as
 * the opening backtick carries no leading whitespace of its own.
 */
export const dedentTemplate = (raw: string): ReadonlyArray<string> => {
  const lines = raw.split("\n").map((line) => line.trimEnd());
  const [first = "", ...rest] = lines;
  const indented = rest.filter((line) => !isBlank(line));
  const minIndent =
    indented.length === 0 ? 0 : Math.min(...indented.map(indentOf));
  const dedented = [
    ...(isBlank(first) ? [] : [first.trim()]),
    ...rest.map((line) => (isBlank(line) ? "" : line.slice(minIndent))),
  ];
  while (dedented.length > 0 && isBlank(dedented.at(-1) ?? "")) {
    dedented.pop();
  }
  while (dedented.length > 0 && isBlank(dedented[0] ?? "")) {
    dedented.shift();
  }
  return dedented;
};

/**
 * Indices of interpolations that occupied a whole line of the source.
 *
 * Conditional `sql` fragments read far better on their own line, and
 * `sql-formatter` has no concept of them: it sees a bare identifier and packs
 * it onto the preceding clause.
 */
const ownLinePlaceholders = (source: SqlTemplateSource): ReadonlySet<number> =>
  new Set(
    source.expressions
      .map((_, index) => index)
      .filter(
        (index) =>
          /\n[ \t]*$/.test(source.quasis[index] ?? "") &&
          /^[ \t]*\n/.test(source.quasis[index + 1] ?? ""),
      ),
  );

/** Puts each {@link ownLinePlaceholders} placeholder back on a line of its own. */
const isolateOwnLinePlaceholders = (
  formatted: string,
  ownLine: ReadonlySet<number>,
): string => {
  if (ownLine.size === 0) {
    return formatted;
  }
  const pattern = new RegExp(`${placeholderPrefix}(\\d+)`, "g");
  return formatted
    .split("\n")
    .flatMap((line) => {
      const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
      const segments: Array<string> = [];
      let cursor = 0;
      for (const match of line.matchAll(pattern)) {
        if (!ownLine.has(Number(match[1]))) {
          continue;
        }
        segments.push(line.slice(cursor, match.index), match[0]);
        cursor = match.index + match[0].length;
      }
      if (segments.length === 0) {
        return [line];
      }
      segments.push(line.slice(cursor));
      return segments
        .map((segment) => segment.trim())
        .filter((segment) => segment !== "")
        .map((segment) => indent + segment);
    })
    .join("\n");
};

/**
 * Re-anchors a multi-line interpolation to the line it now sits on.
 *
 * `getText` returns an expression with the indentation it had in the source,
 * so its continuation lines carry absolute indentation that the caller would
 * indent a second time. Relative structure is preserved; the shallowest
 * continuation line is pinned to `indent`.
 */
const reindentExpression = (expression: string, indent: string): string => {
  const [first = "", ...rest] = expression.split("\n");
  const continued = rest.filter((line) => !isBlank(line));
  if (continued.length === 0) {
    return expression;
  }
  const minIndent = Math.min(...continued.map(indentOf));
  return [
    first,
    ...rest.map((line) =>
      isBlank(line) ? "" : indent + line.slice(minIndent),
    ),
  ].join("\n");
};

/**
 * Swaps placeholders back for their expressions, one line at a time so each
 * multi-line expression can be re-indented to its own line.
 */
const restorePlaceholders = (
  formatted: string,
  expressions: ReadonlyArray<string>,
): string => {
  // One pass per line, so `oxsql_param_1` never swallows `oxsql_param_10`.
  const pattern = new RegExp(`${placeholderPrefix}(\\d+)`, "g");
  return formatted
    .split("\n")
    .map((line) => {
      const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
      return line.replaceAll(pattern, (match, digits: string) => {
        const expression = expressions[Number(digits)];
        return expression === undefined
          ? match
          : `\${${reindentExpression(expression, indent)}}`;
      });
    })
    .join("\n");
};

/**
 * Runs `sql-formatter` over the statement with interpolations swapped for
 * identifier placeholders, then restores them.
 *
 * Returns `undefined` when the statement cannot be formatted, so the caller
 * can fall back to indentation-only handling.
 */
export const formatStatement = (
  source: SqlTemplateSource,
  options: SqlTemplateOptions,
): ReadonlyArray<string> | undefined => {
  const withPlaceholders = interleave(
    source.quasis,
    source.expressions,
    placeholderFor,
  );
  let formatted: string;
  try {
    // Dedent first: `sql-formatter` reproduces the contents of multi-line
    // tokens (dollar-quoted bodies, string literals, block comments)
    // verbatim, so indentation left inside one would be re-indented by the
    // caller on every run and drift a level deeper each time.
    formatted = formatSql(dedentTemplate(withPlaceholders).join("\n"), {
      dataTypeCase: "preserve",
      expressionWidth: options.expressionWidth,
      functionCase: "preserve",
      identifierCase: "preserve",
      keywordCase: "upper",
      language: options.dialect,
      tabWidth: options.indentWidth,
    });
  } catch {
    return undefined;
  }
  const restored = restorePlaceholders(
    isolateOwnLinePlaceholders(formatted, ownLinePlaceholders(source)),
    source.expressions,
  );
  if (restored.includes(placeholderPrefix)) {
    return undefined;
  }
  if (sqlFingerprint(restored) !== sqlFingerprint(rawTemplateText(source))) {
    // The formatter (or placeholder restoration) changed more than whitespace;
    // never rewrite a statement we cannot prove equivalent.
    return undefined;
  }
  return restored.split("\n").map((line) => line.trimEnd());
};

/**
 * Whitespace- and case-insensitive view of a statement.
 *
 * Formatting may only move whitespace and change keyword case, so a changed
 * fingerprint means the rewrite is unsafe.
 */
const sqlFingerprint = (sql: string): string =>
  sql.replaceAll(/\s+/g, "").toLowerCase();

/**
 * Checks that a SQL tagged template starts on the line after the opening
 * backtick, is indented one level past the statement, and closes on its own
 * line.
 */
export const checkSqlTemplate = (
  source: SqlTemplateSource,
  options: SqlTemplateOptions = defaultOptions,
): SqlTemplateCheck => {
  const raw = rawTemplateText(source);
  if (raw.trim() === "") {
    return { kind: "ok" };
  }
  if (options.allowSingleLine && !raw.includes("\n")) {
    return { kind: "ok" };
  }

  const statement =
    (options.formatBody ? formatStatement(source, options) : undefined) ??
    dedentTemplate(raw);
  if (statement.length === 0) {
    return { kind: "ok" };
  }

  const bodyIndent = source.baseIndent + " ".repeat(options.indentWidth);
  const expected = [
    "",
    ...statement.map((line) => (isBlank(line) ? "" : bodyIndent + line)),
    source.baseIndent,
  ].join("\n");
  return raw === expected ? { kind: "ok" } : { expected, kind: "violation" };
};
