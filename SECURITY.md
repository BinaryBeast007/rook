# Security policy

## Supported versions

Rook is pre-1.0. Only the latest release gets security fixes.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub:
[Report a vulnerability](https://github.com/BinaryBeast007/rook/security/advisories/new)
(the repository's **Security** tab, then **Report a vulnerability**).

Please include:

- What is affected (the component, version, and OS)
- Steps to reproduce, or a proof of concept
- The impact as you understand it

You should get an acknowledgement within a few days. We will keep you updated while we work on a
fix and credit you in the advisory unless you would rather stay anonymous.

## Scope

Rook runs coding agents with access to your files and shell, so the following are especially
relevant:

- Escapes from the sandboxed renderer, or IPC calls accepted from an untrusted origin
- Paths that let a workspace read or write outside its folder
- Credentials or tokens leaking into logs, chats, or error messages
- Problems with the auto-update or packaging pipeline

Bugs in the third-party agents Rook drives (Claude Code, Codex, Cursor, and others) should go to
those projects.
