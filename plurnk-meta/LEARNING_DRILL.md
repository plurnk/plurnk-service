<!-- Adopted from the dissolved plurnk-learn repo (2026-07-20) — the owner's personal TEACH drill design; a home for the document, not yet a build commitment. -->

# Plurnk Interface Manifesto

This document defines Plurnk's **membrane**: the boundary where the opaque core of "plurnk magic" meets the world around it. It is structural, not temporal — it describes what exists and how it relates, not what ships when. The roadmap lives elsewhere.

The core — the engine, the ledger, tokenomics, the DSL's internal machinery — is treated here as a black box. How the magic works internally is deliberately out of scope. This document specifies only where that box touches something outside itself.

The membrane has three concentric layers:

* **Plurnk Internal Ecosystem** — the core systems and the seams between them.
* **Plurnk Plugin Ecosystem** — the defined protocols for pluggable interfacing with the core.
* **Plurnk External Ecosystem** — the community and industry standards Plurnk speaks to.

## Why this document exists

The aim is to keep responsibility at the right seam. Every failure mode below is a case of work landing where it doesn't belong:

* Changing plurnk because the plugin infrastructure doesn't meet needs.
* Building EXEC plugins because the MCP plugin isn't complete.
* Plurnk unnecessarily using different paradigms and practices when there are mature and supported standards.

These are the thesis, not the preamble. Each section exists to answer, for its component: *what pressure would make this absorb work that belongs elsewhere, and what rule prevents it?*

## The membrane test

One rule decides whether a concern belongs in this document: **does it cross the membrane?**

* Tokenomics, the budget grinder, the ledger, the DSL parser — *inside the magic*. Out of scope here.
* Proposals / human approval, plugin discovery, plugin trust, the wire an external standard arrives on — *on the membrane*. In scope here.

If a concern is purely how the core reasons about itself, it stays a black box. If it is how the core is reached, admitted, approved, or answered from outside, it is specified here. The **Non-Goals** section is the same test applied in reverse: what the membrane refuses to let in.

---

## Plurnk Internal Ecosystem

The project is a family of agents. The roster below is the *cast*; the **seams between them are the content**. Governance is the anti-scope-creep machinery: coordination is issue-based, no agent edits another's tree, and the grandma contract adapts only on genuine, surfaced need.

* **meta** — the mom and head of household: coordinates releases, routes complex issues, owns project alignment and assembly.
* **grammar** — the grandma: final authority on the plurnk language and specification, but elderly, settled, and now living in mom's house. Adapts only when a real need is raised.
* **core** — the plurnk-service daemon and engine: database designer and head implementation architect. Owns engine behavior; owns nothing about assembly or release.
* **schemes** — the URI scheme protocols at the heart of the universal-resource paradigm.
* **mimes** — mimetypes and their handling, including the semantic embedder.
* **execs** — execution streams, including the load-bearing execs-mcp plugin.
* **providers** — diverse model-endpoint configuration and communication.
* **client** — server-side AG-UI plus the thin CLI, TUI, and Neovim client interfaces.
* **bench** — industry benchmarking run against the service daemon.

Each `###` section below, when filled, states three things and nothing more: what the component **consumes**, what it **exposes**, and who it may **not** reach into — followed by its scope-creep pressure and the rule that resists it. Keep them sparse; fill on demand, when a real boundary dispute requires it.

### meta

### grammar

### core

### schemes

### mimes

### execs

### providers

### client

### bench

### Proposals & HITL (cross-cutting membrane concern)

Not owned by a single agent: the seam where the core surrenders an action to a human for approval. Permission decisions are addressable entries, not opaque prompts; a proposal crosses from core out to the client (AG-UI) and back. Specified here because approval is a membrane event, not internal reasoning.

---

## Plurnk Plugin Ecosystem

Three families extend the core without changing it:

* **Schemes** — create your own `scheme:///` with its own behavior.
* **Mimetypes** — handle the structure and tree-sitter parsing of document types.
* **Execs** — provide your own bespoke executable streams to the model.

Two mechanisms make "third-party plugins light up with zero engine change" true. They are the actual pitch of this ecosystem and belong on the membrane:

* **Discovery** — each family ships a flat `@plurnk/<family>-all` aggregator, and plugins are found by a scope-agnostic scan of `node_modules` for `plurnk.kind:"<family>"` — any scope, not just `@plurnk`.
* **Trust** — discovery is gated by `PLURNK_PLUGINS_TRUSTED_ONLY`. Untrusted code does not light up by default. (Post-ClawHavoc, this is a headline, not a footnote.)

### Schemes

### Mimetypes

### Execs

### Discovery

### Trust

---

## Plurnk External Ecosystem

The external layer is best read as **verticals**, not a flat list. Each industry standard enters through a plugin seam and lands on an internal contract. The verticals *are* the architecture:

* **AG-UI** — external standard → **client** seam → core protocol surface. All user-facing interaction rides AG-UI, with Plurnk-specific matters carried as metadata.
* **A2A** — external standard → **schemes-a2a** plugin → schemes contract → core. All foreign agents are reached (and, later, expose Plurnk) through the schemes-a2a plugin. Plurnk conforms on the wire; the plugin presents A2A in a `run://`-ergonomic face internally.
* **MCP** — external standard → **execs-mcp** plugin → execs contract → core. All external tools reach Plurnk through the execs-mcp plugin.

**Providers is the asymmetric vertical.** Every daughter above maps to an *agent-protocol* standard; providers maps to a *de-facto wire reality* — OpenAI-compatible endpoints plus token-level grammar-constrained decoding (GBNF/XGrammar). It consumes a wire convention, not an agent protocol, and that difference is deliberate: the grammar requirement is non-negotiable, and endpoints that cannot satisfy it are out of scope regardless of popularity.

### AG-UI

### A2A

### MCP

### Providers / the wire

---

## Non-Goals

What the membrane refuses to absorb. This section is the direct antidote to the first failure mode; every entry is a boundary Plurnk will not cross even under pressure to "just add it here."

* **No developer-facing, code-first orchestration API.** Plurnk moves orchestration into the model, not into a developer's graph. It competes with code-first frameworks (MAF, LangGraph, ADK) only by making them unnecessary — never by imitating them. Where deterministic, developer-authored, checkpointed workflow is genuinely required, Plurnk is a *node in your graph*, not the graph.
* **Not the model's memory manager.** The model curates its own context (OPEN/FOLD/KILL against a budget). Plurnk does not run a retrieval pipeline *for* a stateless model; that is the RAG-framework layer Plurnk replaces by relocating it into the model.
* **Not a vector-infrastructure provider at scale.** The built-in semantic search serves the agent's own working set. For large external corpora, Plurnk composes with the corpus's own search backend as a scheme — it consumes scaled retrieval, it does not manufacture it.
* **Not an enterprise-commerce-standard endpoint.** The payment rail is deliberately its own; Plurnk does not chase the mainstream agent-commerce standards. (This one is a forced, eyes-open exception, not an oversight.)
