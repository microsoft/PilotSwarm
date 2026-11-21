# Authority audit of the request code at 8021c75e

This note states the assumption A-OWN of `WorkflowRequestCode.tla` and the
source audit behind it.

## Status of the claims

- `Refines` (in `WorkflowRequestCode.tla`) is a refinement **obligation**.
  The recorded result is in `README.md`.
- The code model covers one request **that is already entered** in the store.
  It is conditional on that entry. It does not show that the runtime at
  8021c75e can enter a request: the plan activity refuses request states
  (`runtime.ts` 1376).
- The expected PASS of `rc-hd-refines` and `rc-hd-refines-limit`
  depends on A-OWN. That is the `CLoseAuthority` guard of the code model, which lets authority
  change only while no response transaction is open. The guard is a model
  assumption, not a fact of the implementation. The code locks only the two
  `sessions` rows (`lockSessionPair`, `store.ts` 1055-1079). It reads
  `session_owners`, `users` and the definition's parent in later statements
  without locks.
- C1 (the generic `elapseWait` and `completeNode` can act on a request node)
  remains a latent store-surface candidate while the production request plan
  is refused. It is not a live bug.

## Source audit of the authority inputs

The request rule is `decideRequestAuthority` (`authority.ts` 89-99). It calls
`decideTypedInputAuthority` (62-75) with the requester taken as not deleted.
The rule allows the responder when it is the requester's parent in both the
session row and the definition, or when both sessions have the same user owner
key. The key is the exact stored provider and subject (`userOwnerKey`, 53-59).

All paths were read at 8021c75e without fetching anything and without any
database effect.

| Input | Read by | Lock | Writers at 8021c75e | Can it remove authority during an open response? |
|---|---|---|---|---|
| Requester `sessions` row (`deleted_at`, `session_kind`, `parent_session_id`, `is_system`) | `lockSessionPair` | `FOR NO KEY UPDATE` | Soft delete (with trigger 0087); `session_kind = 'workflow'` set once at creation (`cms.ts` 1886). No update of `parent_session_id` or `is_system` was found. | No. Every update of the row waits for the lock. |
| Responder `sessions` row | `lockSessionPair` | `FOR SHARE` | Soft delete; creation-time fields as above. | No. Every update waits for the lock. |
| Definition `parent_session_id` | `lockSessionPair` (third statement) | none | Inserted once with `ON CONFLICT (workflow_session_id) DO NOTHING` (`store.ts` 1503-1507). Updates of `workflow_definitions` set only `state`, revisions and hashes (`store.ts` 1522, 1572, 1618; 0086 70; 0087 48). | No. It never changes. |
| `session_owners.user_id` | `lockSessionPair` (owner join) | none | First assignment only, `ON CONFLICT (session_id) DO NOTHING` (`cms_set_session_owner`, `cms_inherit_session_owner`, `cms-migrations.ts` 3887, 3909). The placeholder-user merge in `cms_register_user` re-points every owner of the placeholder to the real user in one statement (`cms-migrations.ts` 2892, 13911; `feature-flags-0077.ts` 235). | No. A first assignment turns a missing key (no authority) into a key. The merge moves all sessions of the placeholder together, so two sessions that had equal keys still have equal keys. Both writers can only add authority. |
| `users.provider`, `users.subject` | `lockSessionPair` (owner join) | none | Insert, or `ON CONFLICT (provider, subject) DO UPDATE` of `email` and `display_name` only. Other updates set `profile_settings`, `github_copilot_key`, `role`, and the defaults (`cms-migrations.ts` 4236, 4262, 9022, 10163, 10401, 13034, 14948). The placeholder user is deleted only after its owners were re-pointed. | No. Provider and subject never change. Because `(provider, subject)` is unique, equal keys mean the same user row. |

Conclusion for 8021c75e:

- Authority can be **lost** only through the two locked `sessions` rows: the
  soft delete of the responder (see the erratum below for the requester). The
  models have the deletions as `CDeleteResponder` and `CDelete`, and both wait
  for an open response.
- Authority can be **gained** through the unlocked inputs: an owner's first
  assignment, or the placeholder merge. That can happen at any time, also
  during an open response. For an entered request it changes nothing. The
  responder passed the same rule at entry (`recipientDecision`, `store.ts`
  2244-2253), and no path removes that authority except a deletion.

So A-OWN holds at 8021c75e for losses from repository code. It does not cover
writes from outside this repository, such as direct SQL or a manual
administrative change.

## The authority module

`WorkflowRequestCodeAuth.tla` instantiates the code model unchanged. It
replaces its `CLoseAuthority` with an environment chosen by `AuthEnv`.

| Configuration | AuthEnv | Checks | Expected |
|---|---|---|---|
| `rc-hd-refines-auth-source` | `source_8021`: losses only through `CDeleteResponder` and `CDelete` (the audit above) | `TypeOK_C`, `Inv_C_StatusMapped`, `Inv_C_NoCorruptAnswer`, `Refines` | PASS, conditional on an entered request and on no writes from outside the repository |
| `rc-as-auth-unlocked-loss` | `unlocked_loss`: assumption removed; the responder may lose authority while a response is open | `Refines` | violation: either `RLock` (allowed), `UnlockedLoss`, `RBody` (the intent step `Call` would refuse); or `RLock`, `RBody`, then `UnlockedLoss` while the reading is held (the intent step `LoseAuthority` waits for the lock) |

A violation of `rc-as-auth-unlocked-loss` would show that the refinement
depends on A-OWN. It would not show a code defect, because the audit found no
such path at 8021c75e. The intent model is not changed. Its `LoseAuthority`
waits for an open response, and nothing weakens that requirement.

Erratum. An earlier wording of this note and the header comment of
`WorkflowRequestCodeAuth.tla` say that authority is lost through the soft
delete of the responder **or the requester**. That is wrong for the requester:
`decideRequestAuthority` passes the requester as not deleted (`authority.ts`
97-99), so the requester's soft delete does not revoke the rule. `CDelete`
cancels the pending node and the run; the related live responder can still
replay a known operation for its receipt, and a new call gets the closed
status. Authority is lost only by deleting the responder (`CDeleteResponder`)
or by purging the requester's rows (no path does this at 8021c75e, and the
model has no purge). The code model's `CRule` already ignores the requester's
deletion, so no result changes.
