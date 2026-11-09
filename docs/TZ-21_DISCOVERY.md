# TZ-21 discovery and station sharing

Public metadata renderer with bounded escaped station names, descriptions and canonical HTTPS links to the current broadcast. A mandatory current disclosure/moderation authorizer checks every station before rendering; private, withdrawn and unapproved records are omitted. Responses use no-store so moderation changes are not deliberately cached. No identity, media capability, key, event coordination or song selection is emitted.

Tests cover canonical links, hostile records/origins, provider failure and mandatory explicit disclosure permission. A deployed host must bind the authorizer to actual privacy/moderation/publication decisions and route station links to its authorized live endpoint. Browser and field qualification remain separate.
