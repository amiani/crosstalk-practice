import { describe, expect, it } from "vitest";

import {
  checkSqlTemplate,
  defaultOptions,
  dedentTemplate,
  type SqlTemplateSource,
} from "./sqlTemplate.ts";

const source = (
  quasis: ReadonlyArray<string>,
  expressions: ReadonlyArray<string> = [],
  baseIndent = "  ",
): SqlTemplateSource => ({ baseIndent, expressions, quasis });

describe("checkSqlTemplate", () => {
  it("accepts a statement indented one level on its own lines", () => {
    const raw = [
      "",
      "    SELECT",
      "      sp.product_id",
      "    FROM source_products AS sp",
      "    WHERE ",
    ].join("\n");
    const check = checkSqlTemplate(
      source(
        [raw, "\n      AND spi.type IN ('UPC')\n  "],
        ['sql.in("x", ids)'],
      ),
    );
    expect(check.kind).toBe("ok");
  });

  it("accepts single-line templates", () => {
    expect(checkSqlTemplate(source(["SELECT 1"])).kind).toBe("ok");
  });

  it("rejects a statement that starts on the backtick line", () => {
    const check = checkSqlTemplate(
      source(["UPDATE probe_listings SET a = 1\n      WHERE b = 2"]),
    );
    expect(check).toStrictEqual({
      expected: "\n    UPDATE probe_listings SET a = 1\n    WHERE b = 2\n  ",
      kind: "violation",
    });
  });

  it("rejects a body that is not indented past the statement", () => {
    const check = checkSqlTemplate(source(["\nSELECT 1\n"]));
    expect(check).toStrictEqual({
      expected: "\n    SELECT 1\n  ",
      kind: "violation",
    });
  });

  it("preserves relative indentation and interpolations", () => {
    const check = checkSqlTemplate(
      source(
        ["\n    SELECT 1 FROM t WHERE ", " AND b = 2\n      ORDER BY id\n"],
        ["a"],
      ),
    );
    expect(check).toStrictEqual({
      expected: `\n    SELECT 1 FROM t WHERE \${a} AND b = 2\n      ORDER BY id\n  `,
      kind: "violation",
    });
  });

  it("formats the statement when formatBody is enabled", () => {
    const check = checkSqlTemplate(
      source(["\n    SELECT a, b FROM t WHERE c = ", "\n  "], ["id"]),
      { ...defaultOptions, formatBody: true },
    );
    expect(check).toStrictEqual({
      expected: [
        "",
        "    SELECT",
        "      a,",
        "      b",
        "    FROM",
        "      t",
        "    WHERE",
        `      c = \${id}`,
        "  ",
      ].join("\n"),
      kind: "violation",
    });
  });

  it("restores more than ten interpolations without prefix collisions", () => {
    const names = Array.from({ length: 12 }, (_, index) => `value${index}`);
    const quasis = [
      "\n    INSERT INTO t (a) VALUES (",
      ...names.slice(1).map(() => ", "),
      ")\n  ",
    ];
    const check = checkSqlTemplate(source(quasis, names), {
      ...defaultOptions,
      formatBody: true,
    });
    if (check.kind !== "violation") {
      throw new Error("expected a violation");
    }
    for (const name of names) {
      expect(check.expected).toContain(`\${${name}}`);
    }
    expect(check.expected).not.toContain("value1}1");
  });

  it("accepts a multi-line interpolation anchored to its own line", () => {
    const check = checkSqlTemplate(
      source(
        ["\n    INSERT INTO\n      t ", "\n  "],
        [
          [
            "sql.insert(",
            "        rows.map((row) => ({",
            "          a: row.a,",
            "        })),",
            "      )",
          ].join("\n"),
        ],
      ),
      { ...defaultOptions, formatBody: true },
    );
    expect(check.kind).toBe("ok");
  });

  it("re-indents a multi-line interpolation instead of stacking indents", () => {
    const check = checkSqlTemplate(
      source(
        ["\n  INSERT INTO t ", "\n"],
        [
          [
            "sql.insert(",
            "          rows.map((row) => ({",
            "            a: row.a,",
            "          })),",
            "        )",
          ].join("\n"),
        ],
      ),
      { ...defaultOptions, formatBody: true },
    );
    expect(check).toStrictEqual({
      expected: [
        "",
        "    INSERT INTO",
        `      t \${sql.insert(`,
        "        rows.map((row) => ({",
        "          a: row.a,",
        "        })),",
        "      )}",
        "  ",
      ].join("\n"),
      kind: "violation",
    });
  });

  it("falls back to indentation when the statement cannot be formatted", () => {
    const check = checkSqlTemplate(
      source(["\nCREATE TABLE ??? (\n  bogus\n"]),
      { ...defaultOptions, formatBody: true },
    );
    expect(check.kind).toBe("violation");
  });

  it("leaves a dollar-quoted body alone instead of indenting it again", () => {
    // `sql-formatter` reproduces the body verbatim, so re-indenting it would
    // push it one level deeper on every lint run.
    const raw = [
      "",
      "    DO $$",
      "    BEGIN",
      "      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'r') THEN",
      "        CREATE ROLE r;",
      "      END IF;",
      "    END",
      "    $$",
      "  ",
    ].join("\n");
    const check = checkSqlTemplate(source([raw]), {
      ...defaultOptions,
      formatBody: true,
    });
    expect(check.kind).toBe("ok");
  });
});

describe("dedentTemplate", () => {
  it("drops blank leading and trailing lines", () => {
    expect(dedentTemplate("\n\n    SELECT 1\n\n  ")).toStrictEqual([
      "SELECT 1",
    ]);
  });
});
