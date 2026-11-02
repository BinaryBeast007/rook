# Contributing to Rook

Thanks for helping. This guide covers how to set up, what a good change looks like, and how to get
it merged.

## Before you start

- **Bugs:** open an issue using the bug report template. Include your OS, the Rook version, and
  steps to reproduce.
- **Features or larger changes:** open an issue first so the approach can be agreed on before you
  write code.
- **Security issues:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You need Node.js 24 LTS and pnpm 12. The [README](README.md#requirements) lists the exact versions.

```sh
pnpm install
pnpm dev
```

## Making a change

1. Fork the repo and create a branch from `main`.
2. Keep the change focused. Unrelated refactors belong in their own pull request.
3. Add or update tests for any behavior you change. Unit tests sit next to the code
   (`*.test.ts`). End-to-end suites live in `apps/desktop/e2e`.
4. Before you push, run the same checks CI runs:

   ```sh
   pnpm check   # format check, lint, typecheck, icon check
   pnpm test
   ```

   `pnpm fmt` fixes formatting.

5. If the change crosses the main/renderer boundary, follow "Adding a capability" in the
   [README](README.md#architecture). Never give the renderer Node.js access.

## Commits and pull requests

- Write commit messages in the imperative mood, describing what the change does, for example
  "Keep a stage or unstage from stealing focus".
- Open the pull request against `main` and fill in the template.
- CI builds and tests on Windows, macOS, and Linux. All three must pass before a merge.
- Pin dependencies exactly in the `catalog` in `pnpm-workspace.yaml`.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
