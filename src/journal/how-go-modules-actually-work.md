---
title: How Go modules actually work
date: 2025-08-01
displayDate: August 2025
summary: How I learned to read go.mod and go.sum as part of an infrastructure system's build contract, including version selection, integrity checks, private modules, and reproducible builds.
topics: Go, Go modules, Dependency management, Software supply chain, Reproducible builds
---

When I first worked with Go projects, `go.mod` and `go.sum` looked like files that belonged to the build tool rather than files I needed to understand.

That view changed when I started thinking about infrastructure software as a supply chain.

A worker may be deployed into Kubernetes, built into a shared container image, or run close to enterprise data on AWS Outposts. Before any of that can happen, the build system has to answer several questions. Which source modules are required? Which versions will be compiled? How do we know the downloaded content has not changed? How are private modules retrieved? Can the same source be built consistently in CI and on a developer machine?

Go modules provide most of the dependency model behind those answers.

The official [Go Modules Reference](https://go.dev/ref/mod) is detailed, but the mental model I find useful is simpler:

1. `go.mod` describes the module and the minimum dependency requirements used to construct the build list.

2. Minimal version selection decides which module versions belong in that build list.

3. `go.sum` verifies the content retrieved for those versions.

These responsibilities are related, but they are not interchangeable.

## Modules and packages are not the same thing

A package is a directory of Go source files compiled together. A module is a collection of packages that are versioned and distributed together.

The root of a module contains a `go.mod` file. The module path declared there becomes the prefix for package imports inside the module.

A repository can contain one module or several modules. For a small service, one repository and one module is often the simplest arrangement. Multiple modules become useful when parts of a repository have independent release cycles or dependency policies, but they also add versioning and coordination overhead.

For an infrastructure service, the module boundary should represent code that is built and versioned together rather than every internal package becoming its own module.

## Reading go.mod

A simplified file might look like this:

```text
module example.com/platform/scanworker

go 1.24.0

require (
    example.com/dependency v1.4.2
    example.com/another v0.8.1
)
```

The `module` directive identifies the module. It is also the prefix used by packages inside it.

The `go` directive declares the minimum Go version required by the module and selects language and module behavior associated with that version. In modern Go versions, a toolchain refuses to use a module that requires a newer unsupported version.

A `toolchain` directive can suggest a particular Go toolchain while preserving a separate minimum version in the `go` directive. This can be useful when a project supports one minimum version but uses a newer toolchain in development and CI.

A `require` directive names another module and a minimum required version.

Some requirements are marked `// indirect`. This means the main module does not directly import a package from that module, but the requirement is still needed in the module graph.

Indirect does not mean unused. It may represent a module required through another dependency, tests, or module graph selection.

## How minimal version selection works

Go uses minimal version selection to create the build list.

Every module declares minimum versions for its requirements. Go walks the module graph and selects the highest required version of each module. That selected version is the minimum version that satisfies every requirement in the graph.

Suppose the main module requires library A at `v1.4.0`, while another dependency requires the same library at `v1.6.0`. The build list selects `v1.6.0`.

This differs from systems that continually search for the newest version matching a range. Go does not silently choose a newer compatible release merely because one exists. A selected version changes when the module requirements change.

Adding one dependency can still raise another selected version if the new dependency requires it. This is why dependency changes should be reviewed as graph changes rather than as isolated lines.

`go list -m all` displays the selected build list. `go mod graph` shows requirement relationships. `go mod why` helps explain why a package or module is present.

For major versions `v2` and above, the major version normally becomes part of the module path, such as `/v2`. This gives incompatible major versions different import paths and allows them to appear in the same build when necessary.

## What go.sum contains

The `go.sum` file contains cryptographic hashes for dependency module content and dependency `go.mod` files.

A line without `/go.mod` verifies the downloaded module files for that version. A line whose version ends in `/go.mod` verifies only the module file for that version.

When Go downloads a public module, it computes a content hash and compares it with the expected value. The public checksum database can provide a globally consistent record, helping detect a proxy or source that serves different content for the same module version.

This is an integrity guarantee. If the bytes associated with a known version change, verification fails.

It is not a security review.

A checksum does not prove that the dependency is safe, maintained, or free from malicious behavior. It proves that the downloaded content matches the content expected for that module version.

There are two other important details.

First, `go.sum` can contain direct and indirect modules as well as more than one version of the same module. Go may need older module files while resolving the graph.

Second, `go.sum` is not the file that selects the build versions. The selected versions come from `go.mod` requirements and minimal version selection. `go.sum` verifies downloaded content. It is therefore not equivalent to a traditional lockfile, even though it contributes to repeatable dependency retrieval.

Both `go.mod` and `go.sum` should be committed.

## What go mod tidy does

[`go mod tidy`](https://go.dev/doc/modules/managing-dependencies) makes module metadata consistent with the packages and tests in the source tree.

It adds missing requirements needed by imports. It removes requirements that are no longer needed. It also adds required hashes and removes unnecessary entries from `go.sum` according to the module's compatibility rules.

I treat its output as a source change that deserves review. An unexpected removal, version change, or large checksum change can reveal that imports, build tags, generated code, or tests are not arranged as expected.

A useful CI check is to run `go mod tidy` and confirm that it leaves the repository unchanged. This detects changes where source code imports a package but the corresponding module files were not committed.

Other useful commands include:

1. `go mod download` retrieves modules in advance, which can improve container build caching.

2. `go mod verify` checks modules in the local cache against their expected hashes.

3. `go mod graph` prints the module requirement graph.

4. `go mod why` explains why a module is required.

5. `go mod vendor` copies the packages needed for builds into a `vendor` directory.

Vendoring can help restricted or audited environments, but it creates another directory that must remain synchronized. It is a build policy rather than a replacement for understanding module selection.

## Replace directives and workspaces

A `replace` directive can point a module to another version, a fork, or a local directory.

This is useful when testing a change across two modules before publishing a release. It can also temporarily redirect a dependency to a maintained fork.

It is easy to misuse:

```text
replace example.com/shared => ../shared
```

This works only when that relative directory exists. If it is committed as production module configuration accidentally, CI or another developer may not be able to build the project.

A `go.work` workspace can be cleaner for local development across several modules because it groups local modules without changing their published dependency definitions.

Whether `go.work` should be committed depends on whether the workspace layout is shared by the team or is specific to one developer. It should not silently change the modules or versions used by CI.

## Private modules

Private dependencies need additional configuration because their paths should not be queried through the public module proxy or checksum database.

`GOPRIVATE` identifies private module path patterns. Related variables such as `GONOPROXY` and `GONOSUMDB` provide more specific control.

A generic configuration might identify an organization's private namespace:

```text
GOPRIVATE=github.com/example-organization/*
```

The repository credentials still come from version control configuration, workload identity, SSH, or a credential helper. Credentials should never be placed in `go.mod`, `go.sum`, import paths, or source code.

An internal Go proxy can give an enterprise build environment caching, availability, auditability, and policy control for both public and private modules. That proxy becomes part of the software supply chain and needs the same operational care as an artifact registry.

## Reproducible builds need more than module hashes

Committing `go.mod` and `go.sum` is necessary, but it does not capture every build input.

The Go toolchain version matters. Build flags and tags matter. Environment variables matter. Code generators matter. C libraries matter when CGO is enabled. The compiler container and embedded version control information can also affect the artifact.

A dependable build should record or control:

1. The Go toolchain version.

2. The module files.

3. Build tags and flags.

4. Generated source and generator versions.

5. The target operating system and architecture.

6. C compiler and native library inputs when CGO is enabled.

7. The builder image through an immutable reference when stronger repeatability is required.

The final executable can include its source commit and version so a process running in Kubernetes can be traced back to the build that created it.

## Integrity and vulnerability are different checks

`go.sum` detects unexpected content changes. It does not detect known security vulnerabilities.

[`govulncheck`](https://go.dev/doc/tutorial/govulncheck) examines known vulnerabilities and can identify call paths from the application into affected functions. This can help distinguish a vulnerable module that is merely present from vulnerable code that the application actually reaches.

Dependency review therefore needs several layers:

1. Module selection through `go.mod` and minimal version selection.

2. Content integrity through `go.sum` and the checksum database.

3. Vulnerability analysis through `govulncheck` and security review.

4. License, maintenance, provenance, and organizational policy checks where required.

No single file answers all of those questions.

## The workflow I would use

During development, I would add or update a dependency deliberately with `go get`, inspect the resulting `go.mod` and `go.sum` changes, and run `go mod tidy`.

Before merging, I would run tests, the race detector where practical, `go vet`, and `govulncheck`. CI would confirm that `go mod tidy` produces no uncommitted difference and that the module can be built with the declared toolchain.

For a container build, I would copy `go.mod` and `go.sum` into the builder first, download dependencies into a cacheable layer, then copy the source and compile. The final runtime image would contain the application and only the runtime files it truly needs.

For private dependencies, CI would receive repository access through its workload identity or secret management system. The module files would describe dependency identity and version, never credentials.

## What I want to remember

`go.mod` and `go.sum` are not administrative files to accept without reading. They are part of the build contract.

`go.mod` describes the module and the minimum dependency requirements. Minimal version selection constructs the build list. `go.sum` verifies the retrieved content. Private module settings control where dependency information is allowed to travel. Build configuration supplies the remaining inputs required for reproducibility.

For infrastructure software, this matters because dependency behavior becomes deployment behavior. The code running inside a scanner, controller, or cloud worker is the code selected and verified by this process.

The principle I want to remember is:

> A dependable binary starts with a dependency graph that can be explained, verified, and rebuilt.
