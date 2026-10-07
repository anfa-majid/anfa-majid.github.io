---
title: From stateful scan pods to restartable stages
date: 2026-02-01
displayDate: February 2026
summary: What I learned from separating a three stage scan into stateless workers that exchange durable JSONL artifacts through Amazon S3, including why AWS Outposts matters when processing must stay close to enterprise data.
topics: Distributed systems, AWS Outposts, Amazon S3, Kubernetes, JSONL, Stateless architecture
---

One of the architecture changes I worked through involved a scan that performed three different jobs internally. The jobs formed a sequence, but their pods also depended on one another while the scan was running.

The first job discovered or collected data. The second job transformed the result into the form needed by the next part of the system. The third job completed the final processing or publication step.

The exact responsibilities are less important than the dependency pattern. A scan behaved like one long running unit even though it contained three logically separate stages.

If the first pod was still holding information needed by the second, the second could not make progress independently. If a later pod failed, the system might need an earlier pod to remain alive or repeat work it had already completed. The lifetime of the scan became tied to the lifetime of several pieces of compute.

We moved toward a different model. Each stage performed one bounded piece of work, wrote its output as JSON Lines to Amazon S3, recorded that the output was complete, and exited. The next stage could then start from that durable artifact, even on a different pod or node.

This changed the system from a chain of dependent pods into a chain of restartable stages.

## What stateful meant in the original design

State is the information a system needs in order to continue correctly. For a scan, that can include discovered records, current progress, intermediate transformations, retry information, counters, and knowledge of which step has completed.

A component is stateful when its future behavior depends on information it keeps locally across requests or processing steps. In Kubernetes, that state might live in pod memory, a local file, an open connection, a queue owned by the process, or a volume attached to a particular workload.

Stateful does not mean poorly designed. Databases are intentionally stateful. A scan engine also needs state somewhere because progress cannot be reconstructed from nothing.

The problem was where the scan state lived and how strongly it connected the stages.

The original flow looked roughly like this:

```text
Scan starts
    Stage one pod discovers data
        Stage two pod depends on stage one
            Stage three pod depends on both earlier stages
                Scan completes
```

The pods were separate deployment units, but operationally they behaved like parts of one distributed process. Their execution overlapped, their lifetimes were related, and the failure of one stage could affect the others.

This introduced several costs.

First, Kubernetes could replace a failed pod, but replacing the process did not automatically restore the information that had existed only inside that process.

Second, later stages could not resume cleanly from a stable boundary. A failure near the end of a long scan could force the system to repeat work from much earlier.

Third, the stages were difficult to scale independently. A discovery stage might need high network concurrency while a transformation stage might need more CPU or memory. Keeping them connected encouraged us to size and schedule them as one workflow rather than as different workloads.

Fourth, slow processing in one stage created backpressure across the whole chain. Earlier pods stayed active, retained resources, or accumulated data while waiting for later work to catch up.

The issue was not simply that state existed. The issue was that important state was coupled to temporary compute.

## What stateless means in the new design

A stateless worker does not need the memory or local filesystem of a previous worker in order to process its assigned input. It receives a reference to durable input, performs a deterministic stage of work, writes durable output, and can then disappear.

The revised flow looked more like this:

```text
Stage one pod
    reads source data
    writes stage one JSONL objects to S3
    records stage one complete
    exits

Stage two pod
    reads stage one objects from S3
    writes stage two JSONL objects to S3
    records stage two complete
    exits

Stage three pod
    reads stage two objects from S3
    completes final processing
    records scan complete
    exits
```

The overall workflow is still stateful. It must remember the scan identifier, completed stages, artifact locations, schema versions, record counts, and failures.

What changed is that the compute became stateless. Durable state moved out of pod memory and into services designed to preserve it. S3 stored the stage artifacts, while a control record or workflow engine tracked the state transition from one stage to the next.

I find “stateless compute over durable state” more accurate than saying that the entire system became stateless.

## Why AWS Outposts mattered

[AWS Outposts](https://docs.aws.amazon.com/outposts/latest/userguide/what-is-outposts.html) extends AWS infrastructure, APIs, and operational tooling into a customer location. Compute and storage capacity can run on premises while remaining part of an AWS environment.

This is useful for enterprise scanning because the data being processed may be large, sensitive, or close to systems that are not hosted in a public cloud Region. Moving all raw data across a wide area connection before processing can add latency, consume bandwidth, and conflict with data locality requirements.

Running the scan workers on Outposts allows computation to remain close to the source systems. The local gateway connects Outposts workloads to the local network, while the service link connects the Outpost to its associated AWS Region for management and regional communication.

There are two broad EKS deployment models to understand.

1. Worker nodes can run on Outposts while the EKS control plane remains in the AWS Region.

2. An [EKS local cluster](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-local-cluster-overview.html) can place both the Kubernetes control plane and worker nodes on an Outposts rack.

The second model can keep cluster operations available during some temporary network disruptions because the control plane is local. It does not mean that Outposts should be treated as permanently disconnected infrastructure. Outposts is designed around a service link to its home Region, and the behavior of each AWS service during a disconnection must be considered explicitly.

For this architecture, the important idea was locality. The scan could do its expensive interaction with enterprise data near that data. A completed stage could then persist a smaller, structured intermediate representation instead of requiring all stages to remain connected to the original source.

## Regional S3 and S3 on Outposts are different choices

Saying that a pod writes to S3 is not enough to describe the data path.

If the application writes to a standard regional S3 bucket, the object travels from the Outpost to the AWS Region. That can be the correct design when regional durability, downstream services, or centralized processing are the priority, but service link bandwidth and latency become part of scan performance.

If the deployment uses [Amazon S3 on Outposts](https://docs.aws.amazon.com/AmazonS3/latest/s3-outposts/S3OutpostsWorkingBuckets.html), objects are stored on the Outpost for local access, local processing, and data residency. Applications access an S3 on Outposts bucket through an access point and a VPC endpoint.

The architecture therefore has to make a deliberate decision:

1. Keep intermediate artifacts local with S3 on Outposts.

2. Store them in regional S3 so regional consumers can use them directly.

3. Keep the detailed intermediate data local and send only an approved result to the Region.

The right choice depends on data residency, recovery requirements, available capacity, service link behavior, and where the next stage runs. Outposts is useful because it gives the architecture a local AWS execution boundary, not because it removes every network consideration.

## Why JSONL worked well as the stage boundary

[JSON Lines](https://jsonlines.org/) stores one valid JSON value on each line. In this workflow, each line represented one independently readable record.

A simplified artifact could look like this:

```json
{"scan_id":"scan_example","sequence":1,"resource_type":"file","path":"/example/a"}
{"scan_id":"scan_example","sequence":2,"resource_type":"file","path":"/example/b"}
{"scan_id":"scan_example","sequence":3,"resource_type":"directory","path":"/example/c"}
```

The format had several useful properties.

First, a consumer could process records one line at a time. It did not have to load a single large JSON array into memory before beginning work.

Second, each line was a complete JSON value. Invalid input could be associated with a particular record rather than making the structure of an entire array difficult to recover.

Third, JSONL was easy to inspect during debugging. A developer could examine a small part file, understand the schema, and compare the input and output of a stage.

Fourth, records could be divided into multiple objects. Several workers could process different JSONL parts in parallel without sharing an in memory queue.

Fifth, the format made the boundary between stages explicit. The output of stage one was no longer an internal object graph understood only by two connected processes. It became a versioned data contract that another worker could read later.

JSONL is not the smallest or fastest format for every workload. It repeats field names, uses text encoding, and usually consumes more storage and parsing time than a compact binary or columnar format. If the main requirement were large analytical scans, a format such as Parquet might be a better choice.

For a restartable operational pipeline, JSONL was useful because it balanced streaming, interoperability, debuggability, and implementation simplicity.

## S3 objects are not appendable log files

One detail matters when combining JSONL with S3: an S3 object should not be treated like a local file that many workers continuously append to.

A safer pattern is to create immutable part objects:

```text
scans/{scan_id}/stage-one/attempt-001/part-00000.jsonl
scans/{scan_id}/stage-one/attempt-001/part-00001.jsonl
scans/{scan_id}/stage-one/attempt-001/manifest.json
```

Each worker writes a complete part. Large parts can use multipart upload, but the object becomes the committed stage artifact only after the upload is completed. Amazon S3 provides strong consistency for successful object writes, and updates to one object key are atomic, so a reader sees the previous object or the completed new object rather than a partially replaced value.

The manifest can describe:

1. The scan and stage identifiers.

2. The schema version.

3. The expected part objects.

4. Record counts and byte counts.

5. Checksums or integrity information.

6. The attempt identifier and completion time.

The manifest, or a separate completion marker, acts as the commit point. The next stage does not start merely because one JSONL object exists. It starts after the producer has declared the complete set of objects ready.

This avoids a subtle failure mode where a consumer reads only the first few parts while the producer is still writing the rest.

## How a failed stage resumes

Every scan receives a stable identifier. Every stage also has a known input location and output location.

Suppose stage one finishes successfully and stage two fails halfway through. The system does not need stage one to remain alive. It does not need to reconnect to the original in memory stream. A replacement stage two worker can read the stage one manifest, claim the unfinished partitions, and continue from the durable boundary.

There are two useful levels of recovery.

1. Stage level recovery repeats stage two using the complete stage one output.

2. Partition level recovery repeats only the stage two parts that did not commit successfully.

Partition recovery can save more work, but it requires stronger bookkeeping. The system must know which inputs belong to each partition, which output belongs to each attempt, and when an output is safe to publish.

Retries must also be idempotent. Processing the same input twice should either produce the same named output or produce attempt specific output that is promoted only once. Without idempotency, a retry can duplicate records or publish two conflicting results.

## How this improves performance

Stateless workers do not make computation intrinsically faster. The improvement comes from removing unnecessary coupling and avoiding repeated work.

The architecture can improve effective performance in several ways.

First, a failure in the third stage no longer forces the first two stages to run again. Recovery starts from the most recent durable boundary.

Second, each stage can scale according to its own bottleneck. A network heavy discovery stage can use different concurrency and resource limits from a CPU heavy transformation stage.

Third, pods do not have to remain allocated while they wait for another stage. A stage can release its compute after committing its output, and the scheduler can start the next stage when capacity is available.

Fourth, the object boundary absorbs differences in processing speed. Stage one can finish and exit even if stage two is temporarily delayed. S3 becomes a durable buffer rather than forcing both stages to be healthy at the same moment.

Fifth, Outposts reduces the distance between scan compute and local enterprise systems. The part of the workflow that performs frequent source access can run locally, while later stages operate from structured artifacts.

Sixth, completed artifacts make progress measurable. Record counts, part counts, timestamps, and byte sizes can show exactly where time is being spent instead of presenting the scan as one opaque duration.

There are also new costs. The system serializes and parses JSONL, performs S3 requests, stores intermediate objects, and coordinates manifests and retries. Poor object sizing can create thousands of tiny requests or a few enormous files that limit parallelism.

The goal is therefore not “stateless is always faster.” The goal is to exchange hidden runtime dependency for explicit, durable boundaries that make scaling and recovery more efficient.

## Operational details that make the design dependable

The artifact path should include a scan identifier, stage, attempt, and part number so that two runs cannot overwrite one another accidentally.

Every JSONL record should have a schema version or belong to a manifest that declares one. This allows a consumer to reject incompatible input clearly rather than failing later with a confusing field error.

Workers should write to attempt specific locations and publish a manifest only after validation. A failed attempt can then be cleaned up without affecting the last successful output.

Object sizes should be measured rather than guessed. Very small objects increase request and scheduling overhead. Very large objects reduce parallelism and increase the amount of work repeated after a failed partition.

Intermediate artifacts need lifecycle and retention rules. Durable does not have to mean permanent. Once the final result is committed and the recovery window has passed, old stage objects can expire according to policy.

The bucket, access point, endpoint, and encryption configuration should reflect the sensitivity of the scanned metadata. Each stage should receive access only to the prefixes it needs. The writer for one stage does not automatically need permission to read or modify every other scan.

Metrics should distinguish source reading, JSONL creation, S3 upload, queueing between stages, downstream processing, and retry time. Otherwise the architecture becomes easier to recover but remains difficult to optimize.

## What I learned

The largest conceptual change was realizing that a stateless design does not remove state. It gives state a deliberate home.

Pod memory is temporary. Local files are tied to a failure domain. A chain of live processes makes progress depend on several components remaining available together. Durable stage artifacts allow compute to be replaced without erasing completed work.

AWS Outposts made the locality of the system explicit. Work that needed frequent access to enterprise data could run near that data. S3 or S3 on Outposts created a durable boundary between processing stages. JSONL made that boundary streamable, inspectable, and independent of one process implementation.

The result was more than a performance improvement. The scan became easier to resume, scale, observe, test, and reason about.

The principle I want to remember is simple:

> Keep compute replaceable, keep progress durable, and make every stage boundary explicit.
