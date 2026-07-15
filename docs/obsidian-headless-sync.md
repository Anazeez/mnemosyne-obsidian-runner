# Obsidian Headless Sync for the Ariadne runner

This is a gated runbook, not an installation script. Do not execute it until the
vault owner separately approves the login, remote-vault choice, end-to-end
encryption password entry, global package installation, and any continuous
service creation.

## Safety rules

- Use a dedicated local mirror for Headless Sync.
- Never point Obsidian desktop Sync and Headless Sync at the same local path on
  Hearken.
- Keep the Obsidian account credential, Sync encryption password, Ariadne
  passkey, and OpenAI credential outside the vault and outside shell history.
- Confirm the selected remote is the Standard Sync remote used by the intended
  mobile vault. A local vault name is not proof of remote identity.
- Start interactively. Service installation and unattended continuous execution
  require another approval after one-job acceptance succeeds.

## User-authorized setup commands

Run each command separately and inspect its output before continuing:

```sh
npm install -g obsidian-headless
ob login
ob sync-list-remote
mkdir -p "$HOME/vaults/Core"
read -r -p "Paste the approved remote vault ID: " ARIADNE_REMOTE_VAULT_ID
ob sync-setup --vault "$ARIADNE_REMOTE_VAULT_ID" --path "$HOME/vaults/Core" --device-name "Hearken DNC"
ob sync-config --path "$HOME/vaults/Core" --mode bidirectional --conflict-strategy conflict --configs ""
ob sync --path "$HOME/vaults/Core" --continuous
```

CLI flags can change between Headless Sync releases. Before setup, record
`ob --version` and compare `ob <command> --help` with every command above. Stop
if the installed CLI describes different semantics.

## Before and after a one-job run

Confirm synchronization is settled before the runner reads a work order:

```sh
ob sync-status
```

Then, from the runner checkout:

```sh
npm test
npm run run:once
```

Confirm the resulting Memory files and
`System/Ariadne/Reports/receipt-<job-id>.md` have synchronized before inspecting
them on mobile. Do not run `ariadne-intake-review.js` concurrently.

## Expired claims

Do not delete a claim merely because its timestamp expired. First prove the old
runner is stopped, inspect the matching completion and receipt, confirm Sync is
settled, and preserve the files for audit. A new one-job invocation can reclaim
an expired lease; conflicting terminal state must be investigated rather than
overwritten.

Do not delete `System/Ariadne/Runtime/Transactions`. It contains the durable
before/after journal used to recover a process crash during multi-file Memory
publication; recovery runs before the queue is read.
