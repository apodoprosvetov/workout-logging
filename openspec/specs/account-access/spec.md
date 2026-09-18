# Account Access

## Purpose

Holding an account and staying signed in to it: registering with an email and
password, exchanging credentials for tokens, keeping a session alive without
re-entering the password, and erasing the account together with everything the
system holds about its owner.

Every other capability rests on this one — a workout, a week's volume and an
update channel all belong to the account the caller's token names, and nothing
in this system is addressed by a user id supplied in a path, query or body.

## Requirements

### Requirement: Register an account with an email and password

The system SHALL expose `POST /api/auth/register`, accepting
`{ "email": string, "password": string }` and answering `201` with
`{ "access_token", "refresh_token", "user": { "id", "email" } }` — the new
account is signed in by the act of creating it.

An email SHALL be trimmed and lowercased before it is validated or stored, so
that the address that created an account is the address that can sign in to it.
An email SHALL be at most 254 characters; a password SHALL be at least 8 and at
most 200.

An email SHALL identify at most one account. The system SHALL refuse a second
registration of the same address with `409`, and SHALL decide this on the write
itself rather than on a prior lookup, so that two simultaneous registrations of
one address cannot both succeed.

A malformed body SHALL be refused with `400`. The system SHALL NOT store a
password in a recoverable form.

#### Scenario: Registering
- **WHEN** a visitor registers with an unused email and an acceptable password
- **THEN** the response is `201`, carries an access token, a refresh token and the new account's id and email, and the account can immediately be used without signing in again

#### Scenario: An email that differs only in case or padding
- **WHEN** a visitor registers as `  Foo@Example.com ` and later signs in as `foo@example.com`
- **THEN** both refer to the same account

#### Scenario: An address that is already registered
- **WHEN** a visitor registers with an email an account already uses
- **THEN** the request is refused with `409` and no second account exists

#### Scenario: Two simultaneous registrations of one address
- **WHEN** two registrations of the same email are submitted at the same time
- **THEN** exactly one succeeds and the other is refused with `409`

#### Scenario: A password that is too short
- **WHEN** a visitor registers with a password shorter than 8 characters
- **THEN** the request is refused with `400` and no account is created

### Requirement: Sign in with credentials

The system SHALL expose `POST /api/auth/login`, accepting
`{ "email": string, "password": string }` and answering `200` with
`{ "access_token", "refresh_token" }`.

A rejected sign-in SHALL be refused with `401`, and the refusal SHALL be
identical whether the email is unknown or the password is wrong. A caller SHALL
NOT be able to learn from it whether an address has an account.

The email SHALL be normalized exactly as registration normalizes it.

#### Scenario: Correct credentials
- **WHEN** a registered user signs in with their password
- **THEN** the response is `200` and carries a fresh access token and refresh token

#### Scenario: Wrong password
- **WHEN** a registered user signs in with the wrong password
- **THEN** the request is refused with `401`

#### Scenario: Unknown address
- **WHEN** a sign-in names an email no account uses
- **THEN** the request is refused with `401`, and the response is indistinguishable from the wrong-password refusal

### Requirement: Keep a session alive without re-entering credentials

The system SHALL issue a short-lived access token and a long-lived refresh
token, and SHALL expose `POST /api/auth/refresh`, accepting
`{ "refresh_token": string }` and answering `200` with a new pair.

A refresh token SHALL be single-use: presenting one SHALL revoke it and issue
its replacement. The system SHALL refuse a token that is unknown, expired,
already revoked, or presented a second time with `401`, and SHALL NOT issue
anything in exchange for it.

The system SHALL NOT store a refresh token in a form that lets it be read back
and used. A refresh token SHALL expire on its own after a bounded lifetime even
if it is never presented.

A user SHALL be able to keep working across an access token's expiry without
being asked for their password again.

#### Scenario: Refreshing
- **WHEN** a client presents a valid refresh token
- **THEN** the response is `200` with a new access token and a new refresh token

#### Scenario: Reusing a refresh token
- **WHEN** a client presents a refresh token that has already been exchanged
- **THEN** the request is refused with `401` and no new tokens are issued

#### Scenario: An expired refresh token
- **WHEN** a client presents a refresh token past its lifetime
- **THEN** the request is refused with `401`

#### Scenario: Working across an access token's expiry
- **WHEN** a user's access token expires while they are using the app and a valid refresh token is held
- **THEN** the session continues without the user entering their password

### Requirement: Authenticate every request from the token alone

Every route the API exposes SHALL require a valid access token presented as a
`Bearer` credential, except registration, sign-in, refresh, and the
unauthenticated health check.

The system SHALL take the acting user's identity from the presented token and
SHALL NOT accept it from a path, query parameter or body. A request with a
missing, malformed, expired or unverifiable token SHALL be refused with `401`
before any data is read.

#### Scenario: No credentials
- **WHEN** a request to an authenticated route carries no `Authorization` header
- **THEN** it is refused with `401` and nothing is read or written

#### Scenario: An expired access token
- **WHEN** a request carries an access token past its expiry
- **THEN** it is refused with `401`

#### Scenario: A body naming another user
- **WHEN** a request carries a valid token for one user and a body or parameter naming another user's id
- **THEN** the request acts only on the token's user, and the supplied id has no effect

### Requirement: Delete the account and everything held about its owner

The system SHALL expose `DELETE /api/auth/account` for the authenticated user,
answering `204`, and SHALL erase everything it holds that is scoped to that
user: their workouts with their exercises and sets, their raw submissions and
any stored images, their refresh tokens, their cached weekly volumes and their
rate-limit counter.

The account row SHALL be removed last, so that a failure partway leaves the
account intact and the request safe to repeat. Every step SHALL be idempotent: a
repeated deletion SHALL still answer `204` rather than fail.

Reference data that is not owned by a user — the exercise catalog — SHALL NOT be
touched by a deletion.

#### Scenario: Deleting an account
- **WHEN** a user deletes their account
- **THEN** the response is `204`, their credentials no longer sign in, and no workout, submission, image, token or cached figure of theirs remains

#### Scenario: Deletion interrupted partway
- **WHEN** a deletion fails before it completes
- **THEN** the account still exists and repeating the request completes the deletion

#### Scenario: Deleting twice
- **WHEN** a deletion is repeated for an account that is already gone
- **THEN** the response is still `204` and nothing fails

#### Scenario: The catalog survives
- **WHEN** a user deletes their account
- **THEN** the exercise catalog is unchanged, including entries first created while parsing that user's workouts
