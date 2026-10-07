---
title: Why we moved toward a unified container image
date: 2025-11-01
displayDate: November 2025
summary: What I learned when separate images for every data system became a production problem involving image pulls, node caches, registry traffic, release consistency, and container startup time.
topics: Container images, Docker, Kubernetes, Cloud infrastructure, Image registries
---

One of the production problems I worked on started with a design that seemed reasonable. Every data system had its own connector, and every connector had its own Docker image.

A connector for one storage platform used one image. A connector for another data source used a different image. The pattern kept responsibilities separate and allowed each connector to carry the libraries it needed.

As the number of supported data systems grew, the cost of that decision became much easier to see.

We were no longer managing a few isolated images. We were operating a growing collection of artifacts across a production cloud, even though many of those artifacts contained the same operating system packages, language runtime, connector framework, logging code, security tools, and deployment logic.

The work pushed me to think about a container image as production data that must be stored, transferred, cached, unpacked, secured, and versioned. It is not just a build output.

## What I was working on

Our platform interacted with multiple data systems. Each system needed connector logic that understood its protocol, authentication model, metadata, and scanning behavior.

The original packaging model looked roughly like this:

```text
Data system A
    Connector A
        Docker image A

Data system B
    Connector B
        Docker image B

Data system C
    Connector C
        Docker image C
```

The images were different, but much of their foundation was similar. They shared the same application framework and many of the same runtime dependencies. The data system adapter was often only one part of the complete artifact.

This meant that a logical difference at the connector layer created a full operational artifact at the deployment layer.

## What problem I was trying to solve

The visible problem was the number of images in the production cloud.

The deeper problem was that each additional image created work across the entire image lifecycle.

1. It had to be built and tested.
2. It had to be scanned for vulnerabilities.
3. It had to be tagged and pushed to a registry.
4. It had to be replicated or made available where workloads could run.
5. It had to be pulled by nodes that did not already have its layers.
6. It had to be unpacked into local container storage.
7. It had to be patched and released when a shared dependency changed.

The production symptoms appeared in several forms. A workload could wait while a node pulled an image it had not seen before. A node could contain one connector image but still need to download another image with very similar contents. A shared runtime fix could require rebuilding and publishing many artifacts. Images could also drift if they were rebuilt or patched on different schedules.

The question became:

> Could we preserve connector specific behavior while reducing the number of distinct artifacts the production platform had to distribute and manage?

## What happens when Kubernetes starts a container

Understanding the startup path made the problem clearer to me.

When Kubernetes places a Pod on a node, the node needs the image referenced by the Pod specification. The container runtime resolves the image manifest and determines which content layers are required.

For every missing layer, the node has to retrieve data from the registry, verify it, store it locally, and unpack it for the storage driver. Only after the required image content is available can the runtime create the container and begin the application startup process.

A simplified path looks like this:

```text
Pod scheduled
    Image manifest resolved
        Missing layers downloaded
            Layers verified
                Layers unpacked
                    Container created
                        Application started
                            Readiness confirmed
```

This path contributes to the time between asking for a workload and having a ready connector.

If the image already exists on the node, much of the transfer and unpacking work can be avoided. If it does not exist, the registry, network, node storage, and container runtime all become part of the startup path.

## Why similar images do not always produce useful reuse

Docker images are composed of content addressed layers. A node can reuse a layer when the required digest is already present locally.

At first, this made me expect strong reuse across our connector images. If most connectors used the same runtime and framework, it seemed like the common parts should already be cached.

The important detail is that useful reuse depends on exact layer identity, not only conceptual similarity.

Two images can contain many of the same files and still have different layer digests. A change in a build step, package metadata, file ordering, timestamps, dependency version, or Dockerfile structure can produce different content. Once a lower layer changes, later layers can also be rebuilt and receive new identities.

Layer sharing therefore helps only when the build produces the same reusable layers and the node already has those exact layers.

This was one reason image proliferation remained visible even though Docker already supported layers.

## Where the redundancy accumulated

The redundancy was not limited to registry storage. It appeared at several points in the lifecycle.

### Artifact redundancy

Every connector image had its own manifest, configuration, tags, and release history. Even when two connectors used the same runtime and most of the same application code, the platform still treated them as different image artifacts.

The shared files could also appear inside different layer boundaries. If the resulting layer contents were not byte identical, they produced different digests and could not be reused as the same object.

### Transfer redundancy

A node that had connector image A was not necessarily ready to run connector image B. The container runtime still had to resolve image B and download every layer digest that was missing locally.

This could lead to the same common runtime, framework, and operating system content moving through the production network as part of several image variants.

The transfer did not necessarily happen on every container start. If the exact image content was already present and the pull policy allowed local reuse, the runtime could use its cache. The problem was that every separate connector image created another cache requirement.

### Node storage redundancy

Every node maintained its own local image store. Different connector images consumed cache space on each node, including connector specific layers and any common content that did not produce identical reusable digests.

As more images competed for finite local storage, older or less frequently used content could be removed by image garbage collection. A later workload would then need to retrieve that content again.

### Build and release redundancy

A shared framework change could trigger a rebuild of every connector image. The same security patch, runtime upgrade, logging change, or common bug fix had to move through several build and release paths.

This created another kind of duplication. Even if image distribution were free, maintaining the artifacts still required repeated work and created more opportunities for version drift.

## Why connector images appeared to load again and again

The repeated loading behavior made more sense once I separated a Pod from a node.

A Kubernetes Deployment describes the desired workload, but the scheduler can place each Pod on any suitable node. Image availability is checked on the selected node, not once for the cluster as a whole.

Consider three nodes and three connector images:

```text
Node 1
    Connector image A present
    Connector image B missing
    Connector image C missing

Node 2
    Connector image A missing
    Connector image B present
    Connector image C missing

Node 3
    New node with an empty image cache
```

If connector B moves to Node 1, its missing content must be pulled there. If connector A later moves to Node 2, the same process happens for A. A newly added Node 3 begins cold and must retrieve whichever connector image is scheduled first.

The image can need preparation again in several common situations:

1. The Pod is scheduled on a node that has never used that connector image.
2. Cluster scaling introduces a new node with an empty local cache.
3. A node is replaced or rebuilt.
4. Image garbage collection removes older content to recover disk space.
5. A new image version changes one or more layer digests.
6. A release uses a new immutable digest, even if most application behavior is unchanged.

The delay is not only network download time. The runtime may also need to verify compressed content, write it to local storage, unpack layers, prepare the merged file system, create the container, and wait for the application to pass readiness checks.

A simplified readiness calculation is:

```text
Time to ready
    Scheduling time
    Image resolution time
    Missing layer download time
    Verification and unpacking time
    Container creation time
    Application initialization time
    Readiness check time
```

This is why image reuse can affect user visible startup behavior. The application code may start quickly once the process exists, but the Pod cannot become useful until the complete preparation path finishes.

## Why a unified image changes the cache pattern

With separate images, the cache has to become warm independently for each connector artifact.

```text
Connector A    Image digest A
Connector B    Image digest B
Connector C    Image digest C
```

With a unified image, the connector workloads refer to the same artifact and choose their adapter through runtime configuration.

```text
Connector A    Unified image digest U    Adapter A
Connector B    Unified image digest U    Adapter B
Connector C    Unified image digest U    Adapter C
```

After digest U is present on a node, the node has the image content required for all three connector modes. Starting a different connector no longer requires warming a separate image cache entry for its shared runtime.

This does not eliminate every startup cost. The application still initializes, configuration still loads, authentication still occurs, and the selected adapter may perform its own setup. The improvement is that the container image distribution path becomes common across the connector workloads.

## Why the cache is local to the node

Another detail that mattered was cache location.

The image cache used during container startup belongs to the node. A layer available on one node does not automatically make the same layer available on every other node.

This matters in a production cloud because workloads move. Clusters scale, nodes are replaced, local storage is pruned, and Pods are rescheduled. A connector that starts quickly on a warm node may start slowly on a different node that has to pull the image.

The more distinct images we deploy, the less likely it becomes that the next selected node already contains the exact artifact needed for a particular connector.

## What a unified image meant for us

Moving toward a unified image did not mean making every connector behave the same way. It meant separating runtime packaging from connector selection.

The unified model looked more like this:

```text
Shared connector runtime
    Common framework
    Common observability
    Common security tooling
    Common lifecycle logic
    Data system adapters

Runtime configuration
    Select adapter A, B, or C
```

The image carried the shared runtime and the supported adapter modules. Configuration at startup determined which adapter the process used for a particular workload.

This changed the unit of reuse. Instead of hoping that several separately built images happened to share enough identical layers, we could deploy one known artifact across connector workloads.

Once a node had that artifact, another connector using the same image could start without pulling a different connector image.

## What improved

The first improvement was operational consistency. A common runtime, common logging behavior, and common security updates could move through one image build and release process.

The second improvement was cache predictability. The platform could benefit from one frequently used artifact being present across more nodes instead of distributing cache space across many less frequently used images.

The third improvement was release management. A shared dependency patch did not require coordinating the same change across a growing matrix of connector images.

The fourth improvement was easier diagnosis. When connector workloads used the same runtime artifact, differences in behavior were more likely to come from configuration, adapter logic, credentials, or the target system rather than an unnoticed difference in the underlying image.

## The tradeoffs I had to consider

A unified image is not automatically better in every dimension.

The image can become larger because it contains adapters and dependencies that a single connector process may not use. The first pull onto a completely cold node can therefore take longer than the pull for one carefully minimized connector image.

The dependency set can also become more complicated. Two adapters may require incompatible versions of the same library or native package. Adding more packages can increase the vulnerability surface and the amount of software that must be scanned and maintained.

Release coupling is another concern. A change needed by one connector can cause a new shared image release for every connector. A mistake in the common image can also affect more workloads at once.

For me, the design question was not simply whether one image is better than many images. It was about choosing the unit of packaging that best matched the production system.

The unified approach needs discipline:

1. Keep the base environment minimal.
2. Pin runtime and dependency versions.
3. Use multiple build stages so build tools do not remain in the runtime image.
4. Scan the final artifact and maintain a software bill of materials.
5. Test every supported adapter against the same image digest.
6. Keep connector selection explicit through configuration.
7. Preserve clear module boundaries inside the common artifact.

## How this connected to systems research

Working on this problem helped me see a direct connection between an internal production decision and broader research on container image storage.

Ali Anwar, Ali R. Butt, and their collaborators studied production registry behavior in [Improving Docker Registry Design Based on Production Workload Analysis](https://www.usenix.org/conference/fast18/presentation/anwar). Their work treats the registry as part of the container startup path and studies how production access patterns, transferred data, and response times should influence registry design.

Their later work on [Large Scale Analysis of Docker Images and Performance Implications for Container Storage Systems](https://ieeexplore.ieee.org/document/9242268/) examines redundancy across a very large Docker image dataset and shows why file similarity, layer sharing, registry storage, and client storage behavior deserve systems level attention.

[DupHunter](https://www.usenix.org/conference/atc20/presentation/zhao), also coauthored by Ali Anwar and Ali R. Butt, explores the tension between reducing redundant image data and preserving image retrieval performance.

Our unified image work was not an implementation of those research systems. The connection was the underlying systems problem. Image proliferation affects registry storage, network transfer, local cache effectiveness, pull latency, and operational complexity. The research gave me a broader vocabulary for understanding why the production problem existed.

The engineering decision approached the problem from the application side. Instead of redesigning the registry, we reduced the number of application artifacts that the registry and cluster had to manage.

## What confused me initially

Initially, I thought the main problem was only the number of image names.

The real issue was the number of distinct content paths through the production system. Every distinct artifact influenced registry storage, node cache state, transfer behavior, security patching, release coordination, and startup time.

I also assumed that Docker layer sharing would remove most of the duplication automatically. That assumption ignored how sensitive layer identity is to build structure and how cache state differs from node to node.

The last confusing part was that a larger unified image could still improve the overall system. Looking only at the size of one image misses how often it is reused, how many alternative images it replaces, and how much operational work disappears around it.

## The mental model I use now

I now think of image design as a placement and reuse problem.

```text
Application packaging decision
    Number of image variants
        Registry objects and versions
            Layer transfer and storage
                Node cache coverage
                    Container startup time
                        Workload readiness
```

The image is part of the workload readiness path. Packaging choices can therefore affect how quickly the platform can respond when it launches, restarts, or relocates a connector.

## What I learned

The main lesson was that container images are part of system performance, not just software delivery.

A design that looks modular in source control can create duplication and inconsistency in production packaging. A design that produces one larger artifact can sometimes improve reuse and operations when that artifact is deployed frequently across the same infrastructure.

I also learned to evaluate optimization at the level of the complete system. Image size matters, but so do pull frequency, layer identity, cache coverage, node churn, security maintenance, and release coordination.

The best packaging model depends on which cost dominates in the environment.

## Things I want to remember

1. A Docker image is production data that must be stored, transferred, cached, verified, unpacked, patched, and secured.
2. Conceptually similar images do not guarantee identical reusable layers.
3. Image cache state is local to each node.
4. Container startup time includes image distribution and unpacking, not only process startup.
5. A unified image can improve cache coverage and release consistency, but it can also increase artifact size and release coupling.
6. Shared packaging still requires strong internal module boundaries.
7. The right design should be evaluated across the complete image lifecycle.

This project was a useful example of how a practical production problem can lead back to systems research. The immediate task was to simplify connector deployment. The deeper problem involved storage, caching, distribution, startup latency, and the relationship between application packaging and cloud infrastructure.
