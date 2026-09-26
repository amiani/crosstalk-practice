import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig, type OxlintConfig } from "oxlint";

type Rules = NonNullable<OxlintConfig["rules"]>;

/** Rules already enforced by TypeScript. */
const typeCheckedByTsc = {
  "constructor-super": "off",
  "getter-return": "off",
  "no-class-assign": "off",
  "no-const-assign": "off",
  "no-dupe-class-members": "off",
  "no-dupe-keys": "off",
  "no-func-assign": "off",
  "no-import-assign": "off",
  "no-obj-calls": "off",
  "no-redeclare": "off",
  "no-setter-return": "off",
  "no-this-before-super": "off",
  "no-unexpected-multiline": "off",
  "no-unreachable": "off",
  "no-unsafe-negation": "off",
  "no-with": "off",
} satisfies Rules;

const javascriptPedanticRules = {
  "no-case-declarations": "error",
  "no-fallthrough": "error",
  "no-inner-declarations": "error",
  "no-prototype-builtins": "error",
  "no-redeclare": "error",
} satisfies Rules;

const javascriptRestrictionRules = {
  "no-empty": "error",
  "no-regex-spaces": "error",
  "no-var": "error",
} satisfies Rules;

const typescriptPedanticRules = {
  "no-array-constructor": "error",
  "typescript/ban-ts-comment": "error",
  "typescript/no-confusing-void-expression": [
    "error",
    { ignoreArrowShorthand: true },
  ],
  "typescript/no-misused-promises": "error",
  "typescript/no-unsafe-argument": "error",
  "typescript/no-unsafe-assignment": "error",
  "typescript/no-unsafe-call": "error",
  "typescript/no-unsafe-function-type": "error",
  "typescript/no-unsafe-member-access": "error",
  "typescript/no-unsafe-return": "error",
  "typescript/only-throw-error": "error",
  "typescript/prefer-includes": "error",
  "typescript/prefer-promise-reject-errors": "error",
  "typescript/prefer-ts-expect-error": "error",
  "typescript/require-await": "error",
  "typescript/restrict-plus-operands": "error",
  "typescript/strict-boolean-expressions": "error",
} satisfies Rules;

const typescriptRestrictionRules = {
  "typescript/explicit-member-accessibility": "error",
  "typescript/no-dynamic-delete": "error",
  "typescript/no-empty-object-type": "error",
  "typescript/no-explicit-any": "error",
  "typescript/no-namespace": "error",
  "typescript/no-require-imports": "error",
  "typescript/non-nullable-type-assertion-style": "error",
  "typescript/promise-function-async": "error",
} satisfies Rules;

/** Intentional exceptions to the enabled Oxlint categories. */
const ruleExceptions = {
  "capitalized-comments": "off",
  "func-names": "off",
  "func-style": "off",
  "id-length": "off",
  "init-declarations": "off",
  "max-params": "off",
  "max-statements": "off",
  "new-cap": "off",
  "no-continue": "off",
  "no-debugger": "error",
  "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
  "no-magic-numbers": "off",
  "no-new": "off",
  "no-shadow": "off",
  "no-ternary": "off",
  "no-throw-literal": "off",
  "no-underscore-dangle": "off",
  "one-var": "off",
  "prefer-destructuring": "off",
  "prefer-named-capture-group": "off",
  "prefer-promise-reject-errors": "off",
  "require-await": "off",
  "sort-imports": "off",
  "sort-keys": ["error", "asc", { allowLineSeparatedGroups: true }],
} satisfies Rules;

const typescriptRuleExceptions = {
  "typescript/no-unnecessary-condition": "error",
  "typescript/no-unnecessary-type-assertion": "error",
} satisfies Rules;

const jestRuleExceptions = {
  "jest/expect-expect": "warn",
  "jest/no-commented-out-tests": "warn",
  "jest/no-disabled-tests": "warn",
  "jest/no-hooks": "off",
  "jest/prefer-ending-with-an-expect": "off",
  "jest/prefer-expect-assertions": "off",
  "jest/require-hook": "off",
} satisfies Rules;

const typescriptScopedRules = {
  ...javascriptPedanticRules,
  ...javascriptRestrictionRules,
  ...typeCheckedByTsc,
  ...typescriptPedanticRules,
  ...typescriptRestrictionRules,
  ...typescriptRuleExceptions,
  ...jestRuleExceptions,
} satisfies Rules;

const typescriptFiles = ["**/*.cts", "**/*.mts", "**/*.ts", "**/*.tsx"];

export default defineConfig({
  categories: {
    correctness: "error",
    style: "error",
    suspicious: "error",
  },
  env: {
    builtin: true,
  },
  ignorePatterns: [
    ".cache/**",
    ".yarn/**",
    "coverage/**",
    "dist/**",
    "node_modules/**",
  ],
  jsPlugins: ["./tools/oxlint-sql/plugin.ts"],
  options: {
    typeAware: true,
  },
  overrides: [
    {
      env: { jest: true },
      files: typescriptFiles,
      plugins: ["typescript", "jest", ...recommended.plugins],
      rules: {
        ...recommended.rules,
        ...typescriptScopedRules,
        "effecttsgo/missing-pipeable-signature": "off",
        "jest/no-standalone-expect": "off",
        "sql/template-format": "error",
      },
    },
    {
      files: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/src/__tests__/**/*.ts",
        "**/src/__tests__/**/*.tsx",
      ],
      rules: {
        "typescript/unbound-method": "off",
      },
    },
  ],
  plugins: [],
  rules: ruleExceptions,
});
