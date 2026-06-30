# Smells To Remove

- A domain function accepts `*sql.DB`, repository interfaces, HTTP clients, or `*http.Request`.
- A handler contains pricing, eligibility, validation, or state transition rules.
- Tests require many mocks to check simple business outcomes.
- Test assertions mostly verify "method X was called" instead of returned values or persisted effects.
- The current time, random IDs, or env config are read deep inside core logic.
- ORM models are passed through many layers and used as domain objects.
- A function both decides what should happen and performs every effect immediately.
