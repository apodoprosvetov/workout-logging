# Spec Delta

## Purpose

Reading the exercise catalog over HTTP, so that a client can show a user which
exercise names the system already knows and submit one it will accept, instead
of finding out only when a request is refused. Read-only: introducing or
editing a catalog entry is not part of this capability.

## ADDED Requirements

### Requirement: Expose the exercise catalog for reading

The system SHALL expose `GET /api/exercises`, answering `200` with the catalog
entries a client can choose from. Each entry SHALL carry:

```
{
  "slug": string,        // stable identifier, the join key the rest of the system uses
  "name": string,        // the canonical spelling
  "aliases": string[],   // other spellings that resolve to this entry
  "muscle_groups": string[],
  "equipment": string | null
}
```

Entries SHALL be ordered by `name`, so that a client rendering them in the order
received presents a stable, predictable list.

The response SHALL be complete: a client SHALL NOT have to page through it, and
SHALL NOT have to issue a request per keystroke to discover an entry. The whole
catalog is a fixed, seeded reference list an order of magnitude smaller than one
user's workout history, and a client that holds all of it can match locally.

`aliases` is part of the contract rather than a convenience: a name that
resolves at edit time may not be the canonical spelling, and a client that knew
only the canonical spellings would fail to suggest an entry for a phrasing the
system accepts.

The response SHALL NOT depend on which user asked. The catalog is the same for
everybody, so no entry may be hidden from or added for one caller.

#### Scenario: Reading the catalog
- **WHEN** an authenticated caller requests the catalog
- **THEN** the response is `200` and carries every catalog entry, each with its slug, canonical name, aliases, muscle groups and equipment, ordered by name

#### Scenario: Two users read the catalog
- **WHEN** two different authenticated users request the catalog
- **THEN** both receive the same entries

#### Scenario: An entry with no equipment
- **WHEN** the catalog holds an entry that records no equipment
- **THEN** its `equipment` is present in the response as null, rather than omitted

### Requirement: The catalog is for signed-in callers only

The system SHALL refuse an unauthenticated request for the catalog with `401`,
consistently with every other non-auth route the API exposes.

#### Scenario: No credentials
- **WHEN** the catalog is requested without a valid access token
- **THEN** the request is refused with `401` and no catalog content is returned

### Requirement: Distinguish an unreachable catalog store from an empty catalog

When the store holding the catalog cannot be reached, the system SHALL refuse
the request as a service failure with `503`, and SHALL NOT answer `200` with an
empty list. An empty list means the catalog knows nothing; a client that saw one
would stop suggesting names and silently tell the user that every name they type
is unknown.

#### Scenario: The catalog store is unreachable
- **WHEN** the catalog is requested and the store holding it cannot be reached
- **THEN** the request is refused with `503` and the response body says the catalog could not be read

#### Scenario: A genuinely empty catalog
- **WHEN** the catalog is reachable and holds no entries
- **THEN** the response is `200` with an empty list, distinct from the service failure above
