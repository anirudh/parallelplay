# Failure semantics

| Class                          | Host behavior                                                                      | External effect                                |
| ------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| Retryable                      | Preserve effect identity, reacquire a fenced lease, retry within policy            | Reconcile first; never duplicate intentionally |
| Terminal                       | Record the terminal reason and stop the attempt                                    | None unless an exact prior receipt is observed |
| Authority-requiring            | Terminate safely and route a typed request to Attention                            | None                                           |
| Protocol-invalid               | Reject malformed, reordered, truncated, duplicate-terminal, or unbound evidence    | None                                           |
| Reject without external effect | Append rejection evidence only when the authoritative command contract requires it | Credentials and network are not touched        |

Timeout, cancellation, approval, capability violation, and provider failure are explicit terminal reasons. A stream ending without a terminal message is protocol-invalid, never inferred success. Stale preconditions and global-ceiling violations are rejected before an adapter obtains credentials.
