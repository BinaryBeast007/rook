// Repo-wide lint and format settings. Each app keeps its own build config.
import { defineConfig } from "vite-plus";

const GENERATED = ["dist", "dist-electron", "release", "node_modules", "pnpm-lock.yaml"];

export default defineConfig({
  fmt: {
    ignorePatterns: GENERATED,
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: GENERATED,
    plugins: ["eslint", "oxc", "typescript", "unicorn", "react", "import"],
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      "import/no-unassigned-import": ["warn", { allow: ["**/*.css"] }],
    },
    options: {
      reportUnusedDisableDirectives: "error",
    },
  },
});
