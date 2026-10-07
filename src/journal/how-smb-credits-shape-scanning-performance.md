---
title: How SMB credits shape the performance of network scanning
date: 2026-08-01
displayDate: August 2026
summary: What I learned by working from the public go-smb2 client, following its request and credit paths, and tuning the boundary between SMB protocol flow control and a scanning workload.
topics: SMB, Go, Storage systems, Network protocols, Performance engineering
---

One performance problem I worked on required going below the scanning logic and into the SMB client itself.

The system was reading data from SMB shares. At first, it was tempting to think about performance in familiar application terms: add more workers, increase the buffer size, or read more files concurrently. Those changes can help, but SMB2 and SMB3 place another control loop underneath the application. Before a client can put requests on a connection, it has to work within the credit window granted by the server.

That made the client library part of the performance architecture.

I worked from [hirochachacha's public go-smb2 repository](https://github.com/hirochachacha/go-smb2), created a fork, and made changes for the workload I was dealing with. I am intentionally leaving the private changes and production measurements out of this entry. What I can explain is how the public implementation works, why the credit system matters, where throughput can be lost, and how I now think about tuning an SMB client safely.

The repository has continued to evolve. This discussion uses the [`v1.1.0` implementation](https://github.com/hirochachacha/go-smb2/tree/v1.1.0) as a stable public reference for the credit design described below.

## Why SMB performance is often a latency problem

An SMB scan is not one continuous stream of bytes. It is a sequence of protocol operations.

A client negotiates a dialect, authenticates a session, connects to a share, opens objects, queries information, reads data, and closes handles. Directory traversal adds query operations. Security metadata adds more queries. A scan across many small files can therefore spend more time waiting for request and response cycles than transferring file contents.

This becomes visible when the client and server are separated by network latency.

If a client sends one request and waits for its response before sending the next, every operation pays for another round trip. Increasing CPU or adding a larger local buffer does not remove that wait. The client has to keep useful work in flight so the connection is not idle while responses travel back.

SMB credits determine how much work the client is allowed to have outstanding.

## The repository from the connection upward

The public Go library builds the SMB client in layers.

At the transport layer, SMB messages are framed over a TCP connection. The client negotiates the SMB dialect and capabilities with the server. That negotiation supplies limits such as the maximum read, write, and transaction sizes and whether the connection supports large MTU operations.

The connection layer then maintains the state required to send requests and match responses. In the public implementation, outgoing messages pass through a sender path, while a receiver continuously reads responses from the transport. An outstanding request map associates each response with the request that used the same message identifier.

This separation is important. A client does not have to treat the connection as a single synchronous function call. Multiple requests can exist at the same time, provided that the client has enough credits and the operations are safe to run concurrently.

The file layer turns reads, writes, directory queries, and information requests into SMB packets. Larger reads and writes are divided according to negotiated limits and the number of credits available. The high level file API may look similar to a local file API, but each call eventually becomes network protocol work governed by the connection.

Following that path from `ReadAt` to the credit account and then into the send and receive code was what made the performance behavior understandable.

## What an SMB credit represents

An SMB credit is permission from the server to consume part of the connection's request window.

The connection begins with a small window. The client asks for credits in request headers, and the server decides how many to grant in response headers. The client cannot create credits locally. It can only request them, account for them, and use the granted window correctly.

For multi credit operations, the charge is based on the larger of the request payload and the expected response payload. The protocol defines the calculation in 64 KiB units:

```text
CreditCharge = ceiling(max(send payload, expected response) / 65,536)
```

The exact formula is specified in Microsoft's [credit charge calculation](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-smb2/18183100-026a-46e1-87a4-46013d534b9c). A 64 KiB operation consumes one credit. An operation covering more than 64 KiB needs multiple credits when multi credit requests are supported.

Credits serve two connected purposes.

First, they limit concurrency. If the client has eight credits, it can potentially have eight one credit operations outstanding.

Second, they limit the size of an individual multi credit request. A larger read can consume several consecutive credits at once.

The server remains in control. A large `CreditRequest` is a request for capacity, not a guarantee that the server will grant it. Server policy, dialect support, and administrative limits can all affect the available window.

This is why credits should not be described as a performance switch. They are protocol flow control. Performance improves only when the client uses the available window to keep useful operations in flight.

## How the public credit account works

The public [`credit.go`](https://github.com/hirochachacha/go-smb2/blob/v1.1.0/credit.go) implementation models available credits as tokens in a bounded Go channel.

The channel capacity is the configured maximum credit balance. It starts with one token, reflecting the initial connection state. Before a request is created, the client calls the account's loan operation. Taking a token reserves one credit. A request that needs several credits attempts to take additional tokens.

There is an important detail in this version of the implementation. The first credit wait is blocking, but additional credits are taken only when they are immediately available. If a request wanted sixteen credits and only four were available, the loan can return four rather than waiting for all sixteen.

The read or write path then reduces the payload to the amount covered by those four credits. Progress continues with a smaller request.

That behavior avoids waiting indefinitely for a large credit allocation when the connection can already perform useful work. The tradeoff is that a large transfer may be divided into more SMB requests, which means more headers, more scheduling, and potentially more round trips.

When a response arrives, its `CreditResponse` value is returned to the account. If the server granted fewer credits than the client requested, the account records the difference and carries that unmet request into a later SMB request. This lets the client continue asking for its desired operating window without assuming that the server accepted the previous request.

This design is compact, but it captures an important protocol relationship:

```text
reserve credits -> assign message identifiers -> send request
receive response -> record granted credits -> wake future work
```

The message identifier is part of the same accounting model. A multi credit request consumes a consecutive range from the connection sequence window. The connection advances its sequence value by the request's credit charge, not simply by one. Microsoft's description of [message identifier assignment](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-smb2/5c5f5316-9936-417b-9221-4686de25d414) makes this relationship explicit.

If credit accounting and message identifier accounting disagree, the result is not merely poor performance. The client can produce invalid protocol behavior.

## Where the speed comes from

The library can benefit from credits in two main ways.

The first is request size. When the server advertises large MTU support and grants enough credits, one read can request more than 64 KiB. Larger operations reduce the number of request and response cycles needed to transfer the same amount of data.

The second is concurrency. The connection tracks outstanding requests by message identifier, and the receiver can deliver each response to the correct waiting operation. Independent callers can therefore place multiple requests on the connection instead of requiring the entire connection to wait for one response at a time.

These benefits address different workloads.

For a large file, larger reads and pipelined reads can keep the network busy. For a scan containing many small files, the dominant cost may be the number of open, query, read, and close operations. In that case, bounded concurrency across files may matter more than increasing the size of a single read.

The credit window has to serve both kinds of work. A single large request can consume many credits, while small metadata operations may need only one each. If large transfers always take the available window first, latency sensitive metadata operations can wait behind them. A fast client therefore needs scheduling and fairness, not only maximum parallelism.

## Why adding workers is not enough

An application can start hundreds of goroutines, but the SMB connection still has a finite credit balance.

Once all available credits are reserved, more goroutines only become waiters. They add memory, scheduling work, and cancellation complexity without adding throughput. If the server, storage device, or network is already saturated, more concurrency can make tail latency worse.

The useful concurrency level is bounded by several independent limits:

1. Credits granted by the server

2. Negotiated read, write, and transaction sizes

3. Network latency and bandwidth

4. Server and storage latency

5. Signing or encryption cost

6. The mixture of small metadata operations and large data transfers

7. The application's ability to process returned data

The worker pool should be coordinated with these limits. It should create enough outstanding work to cover latency, but it should not treat the number of goroutines as the performance target.

## What I looked for when tuning the fork

The first step was understanding where time was actually being lost.

If the connection regularly had credits available but no requests in flight, the application was not feeding the protocol layer fast enough. If many operations were blocked waiting for credits, the workload was asking for more concurrency than the current window could support. If credits were available and requests were outstanding but throughput was still low, the bottleneck could be network bandwidth, server latency, storage, signing, encryption, or processing after the read.

A useful tuning process observes at least the following:

1. Current and maximum credit balance

2. Time spent waiting to reserve credits

3. Number of outstanding requests

4. Requested credits compared with credits granted

5. Read and write size distributions

6. Round trip latency by SMB command

7. Throughput and tail latency by file size group

8. Retries, cancellations, and transport failures

Without these measurements, a change can improve one benchmark while making another workload worse.

I also learned to separate connection reuse from request concurrency. Reusing a negotiated session and mounted share avoids repeating authentication and setup work. Request concurrency then determines how much useful work is kept in flight on that connection. Reconnecting more often is not a substitute for using an existing connection well.

## Places where the client can be tuned further

There are several directions in which an SMB client can evolve, depending on the workload.

### Credit aware request scheduling

A scheduler can distinguish between small metadata operations and large data requests. Instead of allowing large reads to consume every available credit, it can preserve room for operations that unblock traversal or file discovery.

The challenge is avoiding starvation in both directions. Always prioritizing small requests can prevent large transfers from progressing. Always granting the largest request first can make metadata latency unpredictable. The policy has to reflect the scanning workload.

### Pipelining independent reads

Large sequential reads that wait for every response before issuing the next request leave throughput tied to round trip latency. Independent `ReadAt` operations over nonoverlapping regions can be issued concurrently, bounded by credits and negotiated sizes.

This needs careful reassembly, cancellation, and error handling. A faster pipeline is only useful if partial responses cannot corrupt ordering or cause the caller to reuse a buffer while a late response is still arriving.

### Adaptive pipeline depth

A fixed worker count behaves differently on a local network and a high latency link. Pipeline depth can be adjusted using the observed credit window, command latency, and throughput. The aim is to keep the connection busy without building a large queue that the server cannot service efficiently.

Adaptation should be conservative. Short spikes should not cause the client to oscillate between too little and too much concurrency.

### Better buffer ownership

Network scanning moves substantial amounts of data through packet encoding, transport reads, decryption, and application buffers. Reusing safely owned buffers can reduce allocation and copying pressure.

Buffer reuse becomes dangerous when requests are asynchronous. A buffer cannot return to a pool until the operation that owns it is unquestionably finished, including cancellation and late response paths.

### Compound requests

SMB can combine related operations into one transport message. In suitable cases, compounding operations such as create, read, and close can reduce round trips.

Compounding is not free. The requests have ordering and failure semantics, the complete packet has to fit transport and credit limits, and a later operation may depend on the result of an earlier one. It is an optimization that needs protocol level tests rather than a generic batching switch.

### Multiple connections or channels

When one connection is the limiting resource, a more advanced client may consider multiple connections or SMB multichannel support. This is a larger protocol feature, not simply another goroutine. Authentication state, session binding, channel sequence behavior, failure handling, and server support all become part of the design.

## Security cannot be tuned away

Signing and encryption consume CPU and can change the amount of copying performed by the client. That makes them visible in performance profiles.

Disabling a required protection to make a benchmark faster is not a valid optimization. The correct comparison measures the system under the security mode required in production and then improves buffer management, concurrency, cryptographic implementation, or hardware use without weakening the protocol contract.

The same applies to timeouts and cancellation. A long timeout can make a benchmark appear stable while causing failed scans to occupy credits and resources for too long. A short timeout can create retries that increase load. Performance and recovery behavior have to be evaluated together.

## How I would evaluate an SMB performance change

One transfer on one server is not enough to establish that a change is better.

I would test a matrix that includes small files, large files, directory heavy scans, different network latencies, and both warm and cold server caches. I would keep the negotiated dialect and security settings visible in every result.

The useful measurements would include total scan time, operations per second, bytes per second, median latency, tail latency, credit wait time, CPU use, memory allocation, and error behavior. I would also check fairness between metadata operations and bulk reads.

Most importantly, I would compare the same workload before and after the change. I would not publish a throughput number without the server, network, file distribution, cache state, and security configuration that produced it. SMB performance numbers without their environment are difficult to interpret.

## What I want to remember

Forking the library made sense because the performance boundary was inside the protocol client, not only in the application using it.

The credit manager connected several things that initially looked separate: request size, concurrency, message identifiers, server flow control, and the number of round trips visible to a scan. Once I followed that connection, the performance problem became much clearer.

The main lesson is that SMB credits do not make a client fast by themselves. They define the amount of work the server permits the client to place in flight. The client becomes fast when it uses that window efficiently, keeps independent work moving, avoids unnecessary round trips, and still preserves fairness, cancellation, security, and protocol correctness.

That is also why this work was more than a library change. It was an exercise in making an application workload, a network protocol, and a concurrency model agree with each other.
