---
title: Why Go keeps appearing in infrastructure systems
date: 2025-09-15
displayDate: September 2025
summary: What working on scanners, cloud integrations, Kubernetes workloads, and restartable data pipelines taught me about why Go fits infrastructure software.
topics: Go, Infrastructure software, Kubernetes, Cloud systems, Concurrency
---

Go appears repeatedly in infrastructure software. Kubernetes, container tooling, cloud controllers, network services, command line tools, and distributed system components are often written in it.

I began to understand why while working with systems that had to connect to different data platforms, run inside Kubernetes, call cloud APIs, process large streams of metadata, and recover cleanly when part of a workflow failed.

The reason is not simply that Go is fast. Infrastructure software has a particular combination of needs. It must be deployable in many environments, handle many independent operations at once, remain understandable during failures, and avoid requiring a large runtime environment in every container.

Go makes several of those requirements easier at the same time.

It also has limitations. Goroutines can leak. Unbounded concurrency can overload a storage system. Garbage collection can affect latency. A compiled binary does not automatically make a service efficient or secure.

Understanding why Go works well in infrastructure means understanding both sides.

## The kind of software I am thinking about

The Go programs connected to my work were not isolated algorithms. They lived at the boundaries between systems.

A scanner might communicate with an enterprise storage platform, traverse resources, normalize metadata, and write durable intermediate results. A cloud worker might read JSONL objects from S3, process them concurrently, and commit the next stage. A Kubernetes component might observe desired state, compare it with actual state, and retry until the two agree.

These programs spend time doing several different kinds of work:

1. Waiting for networks, APIs, storage, and object downloads.

2. Parsing and transforming records.

3. Coordinating concurrent tasks without losing cancellation or error information.

4. Handling partial failure and retrying operations safely.

5. Running as small, observable processes inside containers.

6. Building for more than one processor architecture.

That combination explains much of Go's appeal.

## A practical deployment artifact

Go normally compiles an application into a native executable. The production image does not need a separate language interpreter or a package installation step when the container starts.

If the program does not depend on C libraries, it can often be built with `CGO_ENABLED=0`. A container build can use one image to compile the program and a much smaller image to run it.

This connects directly to the problem of maintaining many connector images. If a connector framework and its adapters can be compiled into one Go binary, the runtime image does not need a complete language toolchain or a separate interpreted environment for every connector. That does not prove that one image is always the right architecture, but it gives the packaging design more options.

Go also supports many operating system and processor combinations through `GOOS` and `GOARCH`. Building Linux binaries for both `amd64` and `arm64` is useful when Kubernetes or edge environments contain different node types.

Cross compilation still needs care. Code using C dependencies may need matching compilers and libraries. A minimal image may also need certificate authority files, timezone data, or other assets that were previously supplied by a full Linux distribution.

The main benefit is predictability. The deployed process is a versioned binary rather than source code plus an interpreter plus packages installed at runtime.

## Concurrency fits infrastructure workloads

Much infrastructure work is concurrent rather than purely computational. A scanner may wait on hundreds of independent network operations. A controller may watch many resources. A service may handle requests while background workers refresh credentials or publish results.

Go represents concurrent work with goroutines. The runtime schedules many goroutines across a smaller number of operating system threads.

Channels can connect goroutines and communicate ownership of work. A scan can use a bounded worker pool:

```go
jobs := make(chan Item)
results := make(chan Result)

for i := 0; i < workerCount; i++ {
    go worker(ctx, jobs, results)
}
```

The important word is bounded. Starting one goroutine for every discovered file can exhaust memory, file descriptors, network connections, API quotas, or the capacity of the storage system being scanned.

The worker count should reflect the real bottleneck. Network limited discovery may benefit from more concurrency. CPU heavy transformation may perform best near the available processor count. A sensitive enterprise system may require a lower value even if the Go process could create thousands of goroutines.

Channels are also not required for every shared value. A mutex can be clearer for a small piece of shared state. The purpose is not to use as many concurrency features as possible. It is to make ownership, backpressure, and shutdown understandable.

## Context makes cancellation part of correctness

Infrastructure work needs deadlines and cancellation. A scan can be stopped. A Kubernetes pod can receive a termination signal. A cloud API request can exceed its useful deadline. A parent stage can fail, making its child work unnecessary.

Go's `context.Context` provides a standard way to carry cancellation and deadlines across API boundaries.

The same context can flow from a top level job into an AWS SDK call, HTTP request, storage connector, and worker goroutine. When the context is cancelled, every component that respects it has a chance to stop promptly.

This matters in a stateless stage worker. If the pod is terminating, the worker should stop accepting new partitions, cancel active network calls, finish or abandon writes according to the commit protocol, and exit before the Kubernetes grace period ends.

A common mistake is starting a goroutine without defining how it ends. Another is creating a derived context and forgetting to call its cancellation function. Both can keep resources alive long after the operation that created them has finished.

I now think of cancellation as part of correctness, not merely cleanup.

## Streaming JSONL without holding the scan in memory

Go's interfaces make streaming pipelines natural. Many APIs accept an `io.Reader` or write to an `io.Writer`, so data can move through a program without first becoming one large byte slice.

For the JSONL artifacts used in a scan pipeline, a worker can open an S3 object body, read one line, decode one record, process it, and continue. Memory use then depends more on concurrency and maximum record size than on the total object size.

```go
scanner := bufio.NewScanner(body)
scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

for scanner.Scan() {
    var record Record
    if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
        return fmt.Errorf("decode record: %w", err)
    }

    if err := process(ctx, record); err != nil {
        return fmt.Errorf("process record: %w", err)
    }
}
```

The buffer configuration matters. `bufio.Scanner` has a default maximum token size. If one JSONL record can exceed it, the program must increase the limit or use another reading strategy. Otherwise an unusually large record can fail a production scan even when the full object is valid.

Streaming solves memory pressure, but it does not solve recovery by itself. The worker still needs to know which part failed, whether output was committed, and whether the operation can be retried safely.

## Static types help at system boundaries

Infrastructure software deals with data from systems that use different names, identifier formats, timestamps, and permission models.

Go structs make an expected record shape visible:

```go
type Record struct {
    ScanID       string            `json:"scan_id"`
    ResourceID   string            `json:"resource_id"`
    ResourceType string            `json:"resource_type"`
    Attributes   map[string]string `json:"attributes,omitempty"`
}
```

Compilation catches many mismatches before deployment. It cannot validate the meaning of external data, so explicit validation is still necessary. A string field can contain an invalid identifier, and an empty value can have several meanings.

Go interfaces are satisfied implicitly. This works well for connectors because a small interface can describe only the behavior the scan engine needs while each adapter hides its protocol specific implementation.

A component may need a record writer, token provider, or object reader rather than every method exposed by a cloud SDK client. Small interfaces reduce coupling and make tests easier to construct. Large interfaces often indicate that the boundary exposes too much of an implementation.

## Go and the Kubernetes reconciliation model

Kubernetes is built around reconciliation. A controller observes the current state, compares it with the desired state, takes an action, and repeats. The action may fail temporarily, so it must be safe to retry.

Go fits this model because goroutines, contexts, typed API objects, and work queues map naturally onto long running controllers.

The important property of a controller is not that it reacts instantly. It is that repeated reconciliation converges toward the desired state without corrupting resources.

The same idea applies outside Kubernetes. A scan stage should be restartable. An S3 artifact should have a clear commit point. Creating a cloud resource should detect whether it already exists. A retry should not create uncontrolled duplicates.

Go does not provide idempotency automatically, but its explicit control flow makes retries and state transitions easier to see during review.

## Errors remain visible

Go treats errors as values returned by functions. This can look repetitive, but it keeps failure paths visible.

When an S3 read, JSON decode, entitlement lookup, or cloud operation fails, the caller decides whether to retry, skip, annotate, or stop. Wrapping an error with `%w` preserves the original cause while adding stage context.

```go
return fmt.Errorf("upload stage output %s: %w", objectKey, err)
```

At a higher layer, `errors.Is` and `errors.As` can recognize known causes without comparing error text.

Infrastructure code still needs an error policy. Transient network failure, rate limiting, invalid input, authentication failure, cancellation, and an internal invariant violation should not all trigger the same retry behavior.

Logging an error and then returning it can also create duplicate logs at every call layer. I prefer adding context while returning and logging once at the boundary that owns the complete operation.

## Testing and diagnostics

Infrastructure failures often depend on timing, concurrency, or resource limits. Go includes useful tools for examining those problems.

`go test ./...` runs tests across the module. Table driven tests work well for protocol variants, permission mappings, path handling, and error classification.

`go test -race ./...` enables the [race detector](https://go.dev/doc/articles/race_detector), which can detect unsynchronized memory access in executed code paths.

`go vet ./...` identifies suspicious constructs that compile but are likely mistakes.

The runtime also exposes CPU, heap, allocation, block, mutex, and goroutine profiles through `pprof`. These profiles can distinguish a slow external API from lock contention, excessive allocation, or a goroutine leak.

For infrastructure workers, I would combine these tools with integration tests against realistic API behavior, failure tests around retries and timeouts, and load tests that measure both the worker and the external system it calls.

## Where Go can still cause problems

The simplicity of creating goroutines can hide resource growth. A blocked goroutine still consumes memory and may retain references to larger objects. Every goroutine needs an ownership and termination story.

Channels can deadlock when sends and receives no longer match. Closing a channel from the wrong side can panic. Shared maps still need synchronization when written concurrently.

Garbage collection makes memory management safer than manual allocation, but allocation rate and retained heap still affect CPU use and latency. Streaming a large S3 object helps only if decoded records are released rather than accumulated until the end.

A compiled executable is not always completely independent of its environment. CGO, certificates, native libraries, name resolution, and timezone data can create runtime dependencies.

Go is also not automatically the best language for every component. Python may be more suitable for model experimentation. Rust or C may be appropriate where fine grained memory control is central. The correct question is whether Go's operational model matches the component being built.

## Why it fits this work

The systems I have worked with share a common shape. They communicate with storage and cloud APIs. They need bounded concurrency. They run in containers. They must stop cleanly, retry safely, and preserve enough context to explain a failure.

Go supports that shape well.

A scan worker can stream JSONL from S3, process records with a bounded pool of goroutines, cancel the pool through a context, and publish a committed output artifact. A connector can expose a small typed interface while hiding protocol details. A Kubernetes controller can reconcile desired and actual state. A cloud tool can compile into one executable for more than one node architecture.

None of these features removes the need for architecture. They make important decisions visible in code.

The lesson I take from using Go around infrastructure is this:

> The language makes simple operational designs easier, but it does not replace the discipline that keeps them simple.
