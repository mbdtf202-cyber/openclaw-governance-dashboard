# Architecture Decision Records

ADRs document changes that alter OpenClaw's structural constraints, not just its
features.

Write an ADR when a change affects one or more of:

- gateway protocol or control-plane contracts
- config shape or validation rules
- plugin boundaries
- cross-channel behavior
- durable task model
- dashboard navigation or operator workflows that become long-lived product surface

Keep one decision per file and prefer append-only records over rewriting history.
