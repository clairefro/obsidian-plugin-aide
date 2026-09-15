import pluginObsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default [
  ...pluginObsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
