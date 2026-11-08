# Release notes

## Experimental delivery preview

The current accepted baseline provides:

- Conversation-bound tasks with requirement revisions and cancellation.
- Bounded Python and Bun execution with explicit input handles and candidate registration.
- Host-configured verification of registered candidate sets.
- Optional delivery export to an explicit host directory, with real file paths, requirement records, a manifest, and bounded previews.
- Repeated delivery reads that recheck actual file identity and bytes.

The default package entry remains an integration probe. Final task acceptance, continuous-task operation, durable recovery, and a daily-use installation profile are not part of this baseline.

See [Architecture](architecture.md) for component boundaries and [Testing](testing.md) for reproducible checks.
