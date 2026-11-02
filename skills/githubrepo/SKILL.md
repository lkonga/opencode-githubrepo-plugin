---
name: githubrepo
description: Search a specified GitHub repository semantically using Copilot embeddings.
---

# GitHub repository semantic search

Run `bun cli.ts --help` from the installed package directory. Search one repository with `bun cli.ts owner/repo "search query"`; optionally repeat `--path PREFIX` to filter results. The CLI searches the default branch only and requires configured GitHub Copilot authentication and repository access. It does not search all of GitHub.
