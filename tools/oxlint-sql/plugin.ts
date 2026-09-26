/**
 * Oxlint JS plugin enforcing SQL tagged-template layout.
 *
 * - `sql/template-indent`: the statement must start on the line after the
 *   opening backtick, be indented one level, and close on its own line.
 * - `sql/template-format`: the same layout, plus the statement body is
 *   reformatted with `sql-formatter`.
 *
 * Both rules are auto-fixable (`oxlint --fix`).
 */
import {
  definePlugin,
  defineRule,
  type Context,
  type ESTree,
  type Visitor,
} from "@oxlint/plugins";

import {
  checkSqlTemplate,
  defaultOptions,
  type SqlTemplateOptions,
} from "./sqlTemplate.ts";

/** Node shape we rely on, narrowed from the loose plugin AST types. */
interface TaggedTemplate {
  readonly range: [number, number];
  readonly tag: { readonly type: string; readonly name?: string };
  readonly quasi: {
    readonly range: [number, number];
    readonly quasis: ReadonlyArray<{
      readonly value: { readonly raw: string };
    }>;
    readonly expressions: ReadonlyArray<ESTree.Node>;
  };
}

/** Matches `sql`, `this.sql`, `db.sql`, ... but not arbitrary tags. */
const isSqlTag = (tag: TaggedTemplate["tag"]): boolean => {
  if (tag.type === "Identifier") {
    return tag.name === "sql";
  }
  if (tag.type === "MemberExpression") {
    const property = (
      tag as unknown as {
        property: { type: string; name?: string };
      }
    ).property;
    return property.type === "Identifier" && property.name === "sql";
  }
  return false;
};

const lineIndentAt = (text: string, offset: number): string => {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
};

const readOptions = (
  raw: unknown,
  formatBody: boolean,
): SqlTemplateOptions => ({
  ...defaultOptions,
  formatBody,
  ...(typeof raw === "object" && raw !== null ? raw : {}),
});

const indentMessage =
  "SQL template should start on the line after the opening backtick, be indented one level, and close on its own line.";
const formatMessage =
  "SQL statement is not formatted. Expected a formatted statement indented one level, starting on the next line.";

const createVisitor = (context: Context, formatBody: boolean): Visitor => {
  const text = context.sourceCode.text;
  /** Ranges already handled, so nested `sql` fragments are skipped. */
  const handled: Array<[number, number]> = [];
  const options = readOptions(context.options[0], formatBody);
  return {
    TaggedTemplateExpression(node) {
      const tagged = node as unknown as TaggedTemplate;
      if (!isSqlTag(tagged.tag)) {
        return;
      }
      const [start, end] = tagged.range;
      if (handled.some(([from, to]) => start >= from && end <= to)) {
        return;
      }
      handled.push([start, end]);

      const check = checkSqlTemplate(
        {
          baseIndent: lineIndentAt(text, start),
          expressions: tagged.quasi.expressions.map((expression) =>
            context.sourceCode.getText(expression),
          ),
          quasis: tagged.quasi.quasis.map((quasi) => quasi.value.raw),
        },
        options,
      );
      if (check.kind === "ok") {
        return;
      }

      const [quasiStart, quasiEnd] = tagged.quasi.range;
      context.report({
        fix: (fixer) =>
          fixer.replaceTextRange(
            [quasiStart + 1, quasiEnd - 1],
            check.expected,
          ),
        message: formatBody ? formatMessage : indentMessage,
        node,
      });
    },
  };
};

export default definePlugin({
  meta: { name: "sql" },
  rules: {
    "template-format": defineRule({
      create: (context) => createVisitor(context, true),
      meta: { fixable: "whitespace", type: "layout" },
    }),
    "template-indent": defineRule({
      create: (context) => createVisitor(context, false),
      meta: { fixable: "whitespace", type: "layout" },
    }),
  },
});
