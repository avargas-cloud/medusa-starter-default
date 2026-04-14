import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import prettier from "eslint-plugin-prettier";

export default [
    {
        ignores: [
            "node_modules/**",
            ".medusa/**",
            ".agent/**",
            "build/**",
            "dist/**",
            "coverage/**",
            "*.js",
            "*.mjs",
            "gh_tool/**"
        ]
    },
    {
        files: ["**/*.ts", "**/*.tsx"],
        plugins: {
            "@typescript-eslint": typescriptEslint,
            "import": importPlugin,
            "prettier": prettier
        },
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                project: "./tsconfig.json"
            }
        },
        rules: {
            // TypeScript Strict Rules
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/no-unused-vars": ["error", {
                "argsIgnorePattern": "^_",
                "varsIgnorePattern": "^_"
            }],
            "@typescript-eslint/explicit-function-return-type": ["warn", {
                "allowExpressions": true,
                "allowTypedFunctionExpressions": true
            }],
            "@typescript-eslint/no-non-null-assertion": "warn",
            "@typescript-eslint/strict-boolean-expressions": "off",

            // Import Organization
            "import/order": ["error", {
                "groups": [
                    "builtin",
                    "external",
                    "internal",
                    "parent",
                    "sibling",
                    "index"
                ],
                "newlines-between": "always",
                "alphabetize": { "order": "asc" }
            }],
            "import/no-duplicates": "error",

            // Code Quality
            "no-console": ["warn", { "allow": ["warn", "error"] }],
            "prefer-const": "error",
            "no-var": "error",

            // Prettier Integration
            "prettier/prettier": "error"
        }
    },
    // Scripts are dev/diagnostic tools — relax strict typing rules
    {
        files: ["src/scripts/**/*.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": "off",
            "@typescript-eslint/explicit-function-return-type": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "no-console": "off",
        }
    }
];
