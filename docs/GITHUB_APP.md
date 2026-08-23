# GitHub App setup and permissions

Create a dedicated GitHub App for the repositories ParallelPlay will observe. Grant metadata read and only the required repository permissions: Contents, Pull requests, Issues, and Checks. Check-run writes require a GitHub App.

Store the App ID, installation ID, and private key as host-side secret references. Installation tokens remain memory-only. Git credentials must be supplied through a pipe-backed helper, never an argument or stored URL.

After exact human promotion of an action/target policy, the adapter may create or update check runs, machine-owned `parallelplay:*` labels, generated comments, immutable `parallelplay/candidate/<revision-digest>` refs, and draft pull requests or their title/body. It uses idempotency markers, compare-and-observe semantics, request IDs, and live reconciliation.

It cannot update or delete a human branch or text, force-push, mark a draft ready, merge, release, deploy, change repository settings/protection, or manage permissions, workflows, environments, or secrets. Generated text is rejected before authority or network access when it contains a secret-like value, mention, slash command, active HTML, image, or non-allowlisted link.
