# Foreman notes (parking lot)

Athena stays runtime-free (D-17): files + conventions + CI checks, no queue, daemon, UI, or
state store. Every idea that needs one of those is **not** an athena feature — it is a
feature request for a hypothetical future orchestration product ("Foreman", a working label
only). Record it here and move on; building it into the harness is out of scope by
definition, not by phase.

Athena's file formats are, deliberately, Foreman's future input spec: task packets = job
format, permission tiers = tool approval defaults, check names = verification, compile adapters =
the heterogeneous model fleet, session logs = telemetry. Writing the conventions first *is*
the product research.

## Promotion triggers

- **D-17**: three or more recorded requests below describe the same pain → consider actually
  starting the product.
- **D-25 / D-28**: review capacity sits idle while agents work on **three** separate
  occasions → evaluate a Claude-Squad-class manager before building anything.

## The idle-review counter (D-25)

Tally occasions where review capacity sat idle while agents worked. At 3, act on the trigger
above.

- (none yet)

## Recorded requests

Format: `date · the pain · what runtime feature it would need`.

- (none yet)
