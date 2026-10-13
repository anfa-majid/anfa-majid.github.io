---
title: "Beyond go.mod: Understanding Dependency Maintenance in Go"
date: 2026-10-13
displayDate: October 2026
summary: "What working with versioned Go libraries taught me about compatibility, transitive changes, and why understanding a dependency's impact matters more than tracking its version alone."
topics: Go, Dependency management, Software maintenance, Semantic versioning, Software supply chain
---

Working with Go-based backend services has made me think differently about dependency updates. On paper, the task looks straightforward: a library publishes a new version, a consuming application updates its requirement, and Go resolves the modules needed to build it.

The interesting part is everything surrounding that version change. Is the release compatible with the application? Does it change another selected module? Does it require a newer Go toolchain? And if the library becomes difficult to maintain, how much of the application actually depends on its behavior?

I have written separately about [how Go modules actually work](/journal/how-go-modules-actually-work), including module checksums, private modules, and reproducible builds. Here I want to focus on a different question: **what does it mean to maintain a dependency over time, rather than simply resolve it for a build?**

## A release version and a selected version are different things

Consider two independent Go modules: a shared library and a service that consumes it. The shared library can evolve on its own schedule, while the service needs to choose when to adopt a particular release.

A consuming service might declare:

```go
module example.com/backend

go 1.24.0

require example.com/shared v1.4.0
```

For a module backed by Git, a release is commonly identified with a semantic-version tag such as `v1.4.1`. The downstream service can update its requirement using a command such as:

```sh
go get example.com/shared@v1.4.1
go mod tidy
go test ./...
```

This is an illustrative workflow, not a claim that every repository releases or tests modules in exactly this way. A tag is a source-control reference; a `require` directive expresses a module-version requirement; and the **selected** version is determined by Go's resolution rules. Those concepts often line up, but they are not interchangeable.

Semantic versioning communicates compatibility intent: patch releases generally represent compatible fixes, minor releases compatible additions, and major releases incompatible changes. But those are promises made by maintainers, not proof that a downstream application's behavior will remain unchanged.

Go also uses semantic import versioning. For modules at major version 2 or higher, the major version normally appears in the module path, for example `example.com/shared/v2`. This means moving from v1 to v2 usually involves an import-path change, rather than simply increasing a number in `go.mod`.

## Why a one-line update may change more than one module

A requirement in `go.mod` is not always an exact lock on the version compiled into a build. Go uses **Minimal Version Selection (MVS)** to choose the highest required version of each module in the relevant module graph. It does not simply choose the newest release available on the internet.

Suppose a backend service has this simplified graph:

```text
backend
├── module A v1.2.0
│   └── module C v1.3.0
└── module B v1.5.0
    └── module C v1.7.0
```

Go selects C at `v1.7.0`, because it satisfies the requirements shown. If a subsequent update to B raises its requirement on C to `v1.9.0`, the selected version of C can change even if the backend does not directly import or update C.

This matters because a dependency change should sometimes be reviewed as a change to the **module graph**, not just as a diff containing one new version number.

A few commands help investigate what changed:

```sh
go list -m all
go mod graph
go mod why -m example.com/shared
go list -m -u all
```

These answer different questions. `go list -m all` shows the selected module build list; `go mod graph` prints module requirements; `go mod why` explains reachability through package imports; and `go list -m -u all` looks for available updates.

An important subtlety is that modules and packages are not identical. A module can appear in a build list without its packages being included in a particular executable. Go also uses module graph pruning and lazy loading in modern module configurations, so the dependency graph is not always the full recursively expanded tree someone might expect.

That distinction becomes important later: seeing a dependency in the graph is evidence of a requirement relationship, not a complete measure of its runtime importance.

## Version compatibility includes the Go toolchain

A module release can have requirements beyond its own exported functions.

The `go` directive in `go.mod` states the minimum Go version required by that module. Since Go 1.21, this minimum is enforced, and a module's declared Go version must be at least as new as those of its dependencies.

Imagine that a service requiring Go 1.24 adopts a new library release that requires Go 1.25. The application may have no direct need for new Go language features, yet adopting the library can still require updating the application's declared minimum Go version and its build environment.

This is different from the optional `toolchain` directive, which suggests a toolchain for working in the main module. With automatic toolchain selection enabled, the Go command may run or download a newer toolchain when necessary.

When considering an upgrade, I therefore try to keep three questions separate:

1. **Library version:** Which release provides the behavior or fix I need?
2. **Module graph:** Which versions will Go select after adopting it?
3. **Build compatibility:** Which Go version and toolchain can build the resulting application?

It is tempting to treat these as one versioning problem, but their failure modes differ. A module may resolve successfully while tests expose an API or behavior change. Alternatively, application code may be compatible while the configured build toolchain is too old.

## A dependency has a maintenance cost, not just a version

Version-selection tools are good at describing requirements. They are less able to explain how hard a dependency would be to change or replace.

Consider two hypothetical Go libraries. One formats diagnostic output for a small internal command. Another implements a protocol relied upon by a central service component.

Both might be ordinary entries in a module file. Both might have a version that appears old. But replacing the first could be a localized change, whereas replacing the second could involve revisiting interfaces, compatibility assumptions, error handling, and integration tests.

This is why I find the phrase “outdated dependency” incomplete on its own. The age of a release is useful information, but a maintenance decision also depends on how the application uses the library. Likewise, a current version does not automatically make a library safe, and an old version does not automatically prove that replacing it is urgent.

A useful review starts with straightforward checks—selected version, release notes, tests, known vulnerabilities—but should also ask which behavior the application depends on and how difficult it would be to move away from that behavior.

## When maintenance stops: a connection to dependency-abandonment research

While thinking about these questions, I read **[Designing Abandabot: When Does Open Source Dependency Abandonment Matter?](https://doi.org/10.1145/3744916.3764519)** by Courtney Miller and collaborators, published at ICSE 2026.

The paper addresses a more specific question than ordinary dependency updates: when an open-source dependency is abandoned, what makes that abandonment consequential to a downstream project?

Through interviews with 22 open-source maintainers, the authors identified four contextual factors shaping abandonment impact: **depth of integration, availability of alternatives, importance of functionality, and external environmental pressures**. They also developed an LLM-based classifier and evaluated its assessments with 124 additional maintainers.

I found the distinction between detecting abandonment and evaluating its *project-specific impact* especially useful.

A dependency-management tool might tell us that a repository has stopped receiving updates. That information alone cannot tell us how much engineering work would be required to replace it, whether a suitable alternative exists, or whether the dependency supports a critical path in the system.

This is not a claim that an ordinary library upgrade is the same as open-source abandonment, or that the paper studied Go microservices specifically. Rather, the paper provides a useful lens for a broader maintenance question: **how do we move from knowing a dependency's status to understanding its consequences for the software that uses it?**

For example, an unmaintained but isolated formatting helper and an unmaintained protocol implementation present very different replacement problems. External security requirements might make either one urgent, but the path to fixing each problem would still depend on its role in the application.

## What I want to carry into future maintenance decisions

Thinking about Go module versioning alongside dependency-abandonment research helps me separate two kinds of visibility.

**Dependency visibility** tells me what modules are required, which versions are selected, how they relate to one another, and which toolchain is needed to build the application. Go provides strong tools for answering those questions.

**Dependency impact** asks something harder: what breaks if this library changes, becomes unavailable, or can no longer be maintained? That requires knowledge of the application, its tests, its interfaces, its critical functionality, and the alternatives available to the team.

Both matter. A disciplined versioning process without an understanding of impact can miss important risks. An intuitive sense that a library is “critical” without examining the actual dependency graph can miss unexpected changes during an upgrade.

The useful lesson for me is not that dependency updates should be avoided or that every library needs an elaborate risk assessment. It is that **choosing a module version and deciding how to maintain that dependency are related, but different, engineering decisions**.

A dependency graph tells us what software relies on. Understanding how those relationships are used tells us what it may cost to change them.

---

### References

1. Go Team. [Go Modules Reference](https://go.dev/ref/mod).
2. Go Team. [Go Toolchains](https://go.dev/doc/toolchain).
3. Courtney Miller et al. (2026). [*Designing Abandabot: When Does Open Source Dependency Abandonment Matter?*](https://doi.org/10.1145/3744916.3764519). ICSE 2026.
