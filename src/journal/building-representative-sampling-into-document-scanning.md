---
title: Building representative sampling into a document scanning pipeline
date: 2026-10-01
displayDate: October 2026
summary: What it took to turn feature based document sampling into a production scanning system that reduced redundant work while preserving useful metadata coverage.
topics: Systems for ML, Representative sampling, Document processing, Data intensive systems, Reliability
---

One of the systems problems I worked on started with a simple observation: when a scan contains a large number of similar documents, scanning every document can repeat a great deal of work without producing much new information.

Suppose a collection contains twenty documents. If twelve of them are sufficiently representative of the structure and characteristics present in the collection, the remaining eight may add little to the metadata discovery objective. The useful question is therefore not always, "How do we scan all twenty faster?" It can be, "How do we decide which documents are worth sending through the expensive part of the scan?"

That question led us to integrate a machine learning based sampling algorithm into the L1 scanning pipeline.

The algorithm was important, but it was not the whole system. The difficult part was making an algorithmic decision safe inside a production workflow. We needed to divide large inputs into manageable sampling windows, obtain comparable features, select representative documents, preserve progress across failures, and measure whether the selected subset still revealed enough about the collection.

This is what made the work interesting to me. It was not only an ML problem and it was not only a distributed processing problem. It was a systems for ML problem.

## The objective was coverage, not an arbitrary reduction

It would be easy to describe the approach as "scan twelve documents instead of twenty," but that misses the main constraint.

Twelve is not automatically a good sample, and a smaller sample is not automatically better. The selected documents have to preserve the information needed by the downstream task.

In this case, the purpose of sampling was to obtain sufficient metadata coverage for a collection while avoiding redundant processing. It was not to claim that the system had produced complete, document level metadata for files it never scanned.

That distinction determines whether sampling is appropriate at all.

If a downstream requirement needs a decision about every individual document, such as a per document compliance result, then representative sampling cannot replace exhaustive processing. If the objective is collection level discovery, format characterization, or learning enough about the shape of a dataset to guide later processing, sampling can be a useful optimization.

The optimization is valid only when its output matches the question the system is expected to answer.

## Similarity gives us a way to reason about redundancy

Before the expensive scan begins, the sampler needs a cheaper representation of each candidate document. At a high level, that representation is a feature vector:

```text
document -> feature extraction -> comparable representation
```

The exact features are implementation dependent. They might describe document type, size, structure, content signals, or an embedding produced by a model. What matters is that the representation preserves the distinctions relevant to the scanning objective.

This introduces the first important systems constraint. Feature extraction must be substantially cheaper than the work it is intended to avoid. If producing the features costs almost as much as performing the full scan, the sampler only moves the expense to an earlier stage.

Once representations are available, the algorithm can compare documents in feature space. Documents with similar representations are more likely to be redundant for the purpose of metadata discovery. Documents far from the current representative set are more likely to add something new.

A useful conceptual model is a novelty score:

```text
novelty(document) = distance from its nearest selected representative
```

If the distance is small, a similar document is already represented. If the distance is large, the document may cover a region of the feature space that the sample has not seen yet.

This is only a mental model, not a description of one required algorithm. The actual selection method can use clustering, learned similarity, ranking, or another strategy. The general principle is the same: spend scan capacity on documents that increase coverage rather than on documents that repeat evidence already present.

This idea is related to representative subset and coreset selection. A coreset is a smaller subset designed to approximate useful properties of a larger dataset. Research on [data subset selection](https://proceedings.mlr.press/v37/wei15.html) also distinguishes representativeness from informativeness. I found that distinction useful in practice. A common document can represent a dense part of the collection, while an unusual document can be informative precisely because it is different.

## Why we needed sampling windows

A very large scan cannot necessarily hold every candidate and every feature representation in memory at once. It may also receive documents incrementally rather than as one complete, static dataset.

Sampling windows make the problem bounded.

Instead of asking the algorithm to select representatives from the entire collection in one operation, the pipeline processes a manageable window of candidates. It extracts or retrieves their features, evaluates similarity, selects the useful representatives, records the decision, and moves to the next window.

Windowing improves memory use and allows selection work to progress in parallel with the rest of the scan. It also creates checkpoints. If a worker fails, the system can resume from a completed window rather than starting the complete sampling operation again.

However, windows create their own correctness problem.

If every window is treated independently, the system may select nearly identical representatives from consecutive windows. It may also miss a rare pattern if the pattern is obscured by the local composition or ordering of one window.

The selector therefore needs some form of continuity across windows. That can be a retained representative set, a compact summary, cluster state, or another persisted view of what has already been covered. The next window is then evaluated against both its local candidates and the information retained from earlier windows.

This turns windowing from simple batching into state management.

Window size also becomes a real operating parameter. A small window reduces memory and shortens recovery boundaries, but it gives the algorithm less context. A large window offers more context, but it increases latency, memory pressure, and the amount of work lost when a window must be retried. There is no universally correct size. It has to be evaluated against the distribution of real scans and the resources available to the workers.

## The production pipeline around the algorithm

The implementation can be understood as a sequence of responsibilities:

1. Candidate discovery identifies the documents that belong to the scan and assigns stable identifiers.

2. Feature extraction produces a comparable representation or retrieves one that already exists.

3. The window builder creates bounded groups of candidates without losing ordering and checkpoint information.

4. The sampling component scores candidates against the coverage already accumulated.

5. Selected documents are placed on the full scan queue, while every selection decision is recorded.

6. Metadata from completed scans is aggregated into the collection level result.

7. Checkpoints preserve window progress, algorithm configuration, feature version, and the identifiers of selected documents.

The boundaries between these stages matter. A model should not have to know how a scan is retried, and a scan worker should not need to reproduce the internal reasoning of the sampler. The contract should communicate the inputs, the selected identifiers, the configuration used, and enough evidence to audit the decision.

This separation also makes the system easier to evolve. A new feature representation or selection strategy can be evaluated without rewriting the entire scanning pipeline.

## Failure handling changes the design

An offline experiment can calculate a representative subset and stop. A production pipeline has to handle partial progress.

If a worker fails after selecting a set of documents but before recording the decision, a retry could produce a different sample. That can duplicate scans or make the final result difficult to explain. We therefore need selection to be deterministic where possible, and we need the decision to be persisted before downstream work is acknowledged.

Determinism includes more than a random seed. It depends on stable candidate identifiers, consistent feature versions, normalized inputs, deterministic ordering where ordering matters, and a recorded algorithm configuration.

Unknown inputs also need an explicit policy. If feature extraction fails for an unusual format, silently excluding the document would make the optimization unsafe. A safer fallback is to send uncertain or unrepresentable documents to the full scan path. In this kind of system, uncertainty should usually increase inspection rather than suppress it.

## Rare documents are where naive sampling becomes dangerous

The most frequent documents are often easy to represent. The difficult cases live in the tail.

A collection may contain thousands of nearly identical documents and only a few files with an unusual structure. An optimization that focuses only on dense regions can report excellent reduction while missing the documents most likely to reveal a new format or metadata pattern.

Similarity based selection can help because an unusual document may be far from the existing representatives. But that benefit depends on the feature representation and thresholds. If the representation does not capture the unusual characteristic, the algorithm cannot protect it.

This is why the production design needs safeguards in addition to the main selection score. Useful safeguards can include minimum representation rules, explicit handling for uncommon types, an uncertainty path, small randomized audit samples, and limits on how aggressively any group can be reduced.

The goal is not simply to maximize the number of skipped scans. The goal is to remove redundancy while keeping the probability of missing useful information within an acceptable boundary.

## Knowing when the sample is sufficient

A fixed sample ratio is easy to operate but difficult to justify across different collections. Twenty highly repetitive documents and twenty highly diverse documents should not necessarily produce the same sample size.

A coverage based system can instead look at marginal information gain. Early selections may add substantial new coverage. As the representative set grows, new candidates increasingly resemble documents already selected. The process can stop when additional selections contribute little new information and the required safeguards have passed.

In practice, stopping can combine several signals:

1. Coverage of the observed feature space

2. The novelty of remaining candidates

3. Minimum samples for important document categories

4. A maximum processing budget

5. Confidence or uncertainty produced by the selection method

6. Operational policies that force full scanning for particular cases

The stopping rule is part of the product behavior, not merely a model parameter. It determines the tradeoff between cost and risk and therefore needs versioning, monitoring, and review.

## Validation required a full scan baseline

Reduction percentages alone do not demonstrate that the sampler works.

To validate the system, the sampled result has to be compared with a baseline produced by exhaustive scanning on evaluation collections. The useful measurements depend on the downstream objective, but the evaluation should answer questions such as:

1. How much of the metadata discovered by a full scan was also discovered through the selected subset?

2. Which categories were missed, and were the misses concentrated in rare document types?

3. How stable were results when input order or window boundaries changed?

4. How much compute time, storage access, network transfer, and end to end latency were saved?

5. How often did the system use its uncertainty or full scan fallback?

6. Did feature or model changes alter the sample composition unexpectedly?

The baseline is especially important because the unscanned portion normally provides no immediate evidence that the decision was correct. Periodic full scan audits provide that evidence and make degradation visible.

Production monitoring then needs both efficiency and quality signals. A falling sample ratio can indicate greater efficiency, but it can also indicate an overly aggressive threshold or a broken feature extractor. Monitoring only the cost metric would reward the wrong behavior.

The broader lesson matches what production ML research has repeatedly observed: the model is one component inside a larger system of data dependencies, validation, monitoring, and operational controls. The paper [The ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) describes production readiness in terms of tests and monitoring around the model, not model quality alone.

## What made this a systems for ML problem

The sampling algorithm gave us a way to rank or select documents. The surrounding system made those selections usable.

We had to decide where feature extraction belonged in the pipeline, how to limit memory with windows, how to carry coverage across those windows, how to make retries deterministic, how to protect rare cases, how to fall back when confidence was low, and how to validate the output against exhaustive processing.

None of those concerns can be solved by model accuracy in isolation.

What I want to remember from this work is that production ML is often about controlling the boundary around an algorithm. The algorithm proposes a decision. The system determines whether that decision is reproducible, recoverable, measurable, and safe enough to act on.

In this case, the result was not simply that fewer documents were scanned. It was that the pipeline could spend its expensive work on a smaller set of documents that contributed more information, while keeping enough evidence and safeguards to justify the reduction.
