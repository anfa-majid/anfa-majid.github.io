---
title: How an EKS workload reaches a Google Cloud environment
date: 2025-09-01
displayDate: September 2025
summary: How I learned to connect an EKS workload, Google Workload Identity Federation, and service account impersonation without moving permanent cloud credentials between environments.
topics: AWS, Amazon EKS, Google Cloud, Workload Identity Federation, Service account impersonation
---

One of the identity problems I worked through involved a workload running in an Amazon EKS cluster that needed to set up or operate an environment in a separate Google Cloud project.

At first, the path sounded simple. The application was already running in AWS, so it needed some credentials for Google Cloud and then it could call the required APIs. What I had to understand was that being authenticated to AWS does not automatically make the workload recognizable to Google Cloud.

The difficult part was deciding what those credentials should be. Copying a Google service account key into AWS would make the connection work, but it would also create a permanent secret that had to be stored, rotated, distributed, and protected. If the key leaked, possession of the file could be enough to use the identity until the key was revoked.

The safer model was based on temporary identities and explicit trust. The EKS workload presented a projected Kubernetes service account token to Google Cloud through Workload Identity Federation. The resulting Google identity impersonated a service account in an identity project, and that service account then impersonated a more restricted service account in the target project.

The same pod could also assume an AWS IAM role when it needed to call AWS APIs. That is a related identity path, but it is not the same exchange. Keeping the two paths separate became one of the most important parts of understanding the design.

The complete path looked like this:

```text
EKS pod
    Projected Kubernetes service account token
        Google Workload Identity Federation
            Federated Google principal
                Bridge service account in GCP
                    Target service account in GCP
                        Google Cloud APIs and resources
```

I think of this as an AWS hosted workload to GCP to GCP identity chain. Each transition answers a different question, and understanding those boundaries is what makes the design easier to reason about.

## The problem I was trying to solve

Suppose a controller, deployment service, or infrastructure tool is running in an EKS cluster inside one AWS account. It needs to create or configure resources in a Google Cloud project owned by a different environment.

There are two separate concerns:

1. Authentication asks who the caller is.

2. Authorization asks what that caller is allowed to do.

The identity chain authenticates the workload across cloud boundaries. IAM roles on the final Google service account authorize the actual operations, such as reading configuration, creating infrastructure, or managing a narrowly defined group of resources.

This distinction matters because successful federation does not automatically grant access to a target project. It only gives Google Cloud a trusted way to identify the external workload. Resource access still has to be granted deliberately.

## What impersonation means in AWS

In AWS, the closest equivalent to service account impersonation is assuming an IAM role. A workload does not receive the permanent credentials of that role. Instead, AWS Security Token Service issues temporary credentials containing an access key identifier, a secret access key, a session token, and an expiration time.

The assumed role session acts with the permissions attached to the role and is constrained by the role trust policy. The trust policy defines who may assume the role. The permission policies define what the role may do after it has been assumed.

That separation is important. Trust is about entering an identity. Permissions are about the actions available once inside it.

For an EKS workload, I do not want every pod to inherit the IAM role of the worker node. A node can run many workloads, so the node role is usually a much larger security boundary than the application needs. The pod should receive its own AWS role based on its Kubernetes service account.

EKS provides two common ways to do this when the pod needs AWS permissions.

### IAM roles for service accounts

With [IAM roles for service accounts](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html), commonly called IRSA, the EKS cluster exposes an OpenID Connect issuer. A Kubernetes service account is annotated with an IAM role ARN, and the role trust policy accepts tokens from the cluster issuer only when the token claims match the expected namespace and service account.

The important claims normally include:

1. The audience, which is restricted to AWS Security Token Service.

2. The subject, which identifies the Kubernetes namespace and service account.

Inside the pod, the AWS SDK reads the projected service account token and calls `AssumeRoleWithWebIdentity`. AWS validates the token and returns temporary role credentials.

The result is a useful identity boundary:

```text
Kubernetes namespace and service account
    trusted by
AWS IAM role
    represented at runtime by
Temporary AWS role session
```

### EKS Pod Identity

[EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html) reaches a similar result through a different mechanism. An association connects a Kubernetes service account to an IAM role. The EKS Pod Identity Agent runs on the cluster nodes and works with the EKS Auth API to obtain temporary credentials for the pod. Supported AWS SDKs read those credentials through the container credential provider.

IRSA places more of the exchange around the cluster OpenID Connect issuer and `AssumeRoleWithWebIdentity`. EKS Pod Identity uses an EKS managed association, the node agent, and `AssumeRoleForPodIdentity` behind the scenes.

For AWS API access, the most important result is the same: the application receives temporary AWS credentials for a dedicated, narrowly scoped IAM role. It does not use a permanent AWS access key and it does not fall back to the broad worker node role.

## The first boundary: from EKS to Google Cloud

Google Cloud needs a way to trust the EKS workload without receiving a Google service account key. This is the purpose of [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation). Google provides a specific [configuration path for Kubernetes workloads, including EKS](https://cloud.google.com/iam/docs/workload-identity-federation-with-kubernetes).

A Google Cloud project contains a workload identity pool. The pool represents a collection of external identities. An OpenID Connect provider inside that pool defines how tokens issued by the EKS cluster are verified, how their claims are mapped, and which Kubernetes identities are allowed to enter the pool.

The pod receives a projected Kubernetes service account token with the Google provider as its audience. The token contains claims such as the issuer, subject, namespace, service account name, and pod name. The EKS cluster signs it. Google Cloud verifies that signature using the cluster issuer information and signing keys.

The provider can map the token subject to `google.subject` and map the namespace and service account name into additional Google attributes. An attribute condition can then accept only the Kubernetes identity expected for this workload.

Conceptually, the trust rule should say:

```text
Accept this specific Kubernetes service account
from this specific EKS cluster and namespace
through this specific federation provider
```

It should not say:

```text
Accept any service account from the cluster
```

That difference prevents an unrelated workload in the cluster from crossing the same trust boundary.

## How Google verifies the EKS identity

The exchange is clever because Google Cloud does not need a secret Google credential stored inside the cluster.

The pod mounts the projected Kubernetes token and a nonsecret external account configuration file. The configuration tells the Google authentication library where to read the token, which provider should receive it, and which service account should be impersonated if impersonation is part of the design. The application normally locates this configuration through `GOOGLE_APPLICATION_CREDENTIALS`.

The token becomes the external subject token sent to the [Google Security Token Service](https://cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token). Google verifies that the token was signed by the expected cluster, that its audience identifies the intended provider, and that the mapped claims satisfy the provider condition.

The sequence is roughly:

1. The pod obtains a projected token for its Kubernetes service account.

2. The Google authentication library reads the token and external account configuration.

3. The workload sends the token to Google Security Token Service with the provider audience.

4. Google verifies the issuer, signature, audience, and token claims.

5. Google maps the Kubernetes service account identity into a federated principal and applies the provider condition.

6. If the identity is accepted, Security Token Service returns a short lived federated Google token.

The projected token proves the pod is running as the expected Kubernetes service account. The Google provider turns that verified identity into an external Google principal.

This is the first cloud boundary:

```text
Projected Kubernetes service account identity
    verified by Google
Federated Google principal
```

The federated token is not a downloaded service account key. It expires, and the exchange can be repeated by the authentication library while the workload remains authorized.

## An alternative AWS identity exchange

Google Workload Identity Federation also supports an AWS provider. In that model, a workload uses temporary AWS credentials to create a signed AWS `GetCallerIdentity` request. Google Security Token Service validates the signed request and maps the verified AWS account and role into a federated principal.

This path can be useful when the AWS IAM role itself is the identity that the Google trust policy is meant to recognize. It requires the Google authentication library or a custom AWS credential supplier to obtain the temporary AWS credentials in a supported form and sign the request correctly.

I would not assume that any AWS SDK credential source is automatically available to every Google authentication library. IRSA, EKS Pod Identity, environment credentials, EC2 metadata credentials, and custom credential suppliers expose credentials through different mechanisms. That compatibility has to be verified for the language, library version, and EKS identity method in use.

For an EKS workload, Google documents direct federation of the projected Kubernetes service account token. I would use that as the default unless the architecture specifically needs the AWS IAM role to be the cross cloud identity.

## The second boundary: from the federated principal to a Google service account

The federated principal can sometimes receive direct access to a Google Cloud resource. For the design I was studying, it was more useful to let that principal impersonate a dedicated bridge service account.

The bridge service account lives in a Google Cloud project used to manage the cross cloud trust boundary. The external principal receives `roles/iam.workloadIdentityUser` on that service account. This permission allows the trusted external identity to request a short lived token for the service account without possessing one of its private keys.

The workload calls the IAM Service Account Credentials API, specifically [`generateAccessToken`](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken). If the policy check succeeds, Google returns an OAuth access token that represents the bridge service account for a limited period.

The transition is:

```text
Federated principal derived from the Kubernetes service account
    allowed to use
Bridge service account
    represented by
Short lived Google access token
```

This is service account impersonation in Google Cloud. The caller is permitted to act as the service account for a limited time, but it never receives the service account private key.

## The third boundary: from one Google project to another

The bridge identity should not automatically have broad access to every target project. Its main responsibility is to cross the federation boundary and reach a carefully selected target identity.

The target Google Cloud project therefore contains its own service account. That service account owns the permissions required for the actual environment setup. For example, it might be allowed to manage a specific set of resources in one project, while having no access to unrelated projects.

The bridge service account receives `roles/iam.serviceAccountTokenCreator` on the target service account. It can then call `generateAccessToken` again and request a token representing the target identity.

Google describes this as [creating short lived credentials through a delegated request](https://cloud.google.com/iam/docs/create-short-lived-credentials-delegated). Every identity in a longer delegation chain must be allowed to impersonate the next identity. The last identity holds the permissions used against the resource.

The second Google transition is therefore:

```text
Bridge service account in the identity project
    allowed to impersonate
Target service account in the resource project
    authorized to manage
Selected resources in the target environment
```

The final access token is the credential used by the infrastructure tool or application when it calls Google Cloud APIs.

It is also possible for the federated EKS principal to impersonate the target service account directly, even when the service account is in another project. The extra bridge is useful only when it creates a meaningful administrative boundary, such as centralizing federation, separating external trust from project permissions, or supporting independently managed target environments. A chain should not be added merely because it is possible.

## The complete request path

Putting the pieces together, one operation follows this path:

1. A pod starts in EKS using a dedicated Kubernetes service account.

2. Kubernetes projects a short lived service account token into the pod with the Google provider as its audience.

3. The Google authentication library reads that token through its external account configuration.

4. Google Security Token Service validates the token through the OpenID Connect provider configured for the EKS cluster.

5. The provider maps the Kubernetes namespace and service account into a federated Google principal.

6. That principal impersonates the bridge service account in the identity project.

7. The bridge service account impersonates the target service account in the destination project.

8. The application uses the final short lived access token to call Google Cloud APIs.

9. The target project authorizes each API request according to the IAM roles attached to the target service account.

No permanent Google credential has to cross into AWS. Each token has a limited lifetime, and every hop can be removed independently by changing a trust policy or IAM binding.

## What has to be configured on each side

The design became much clearer to me when I separated configuration by ownership.

### In the AWS account

1. Create a dedicated Kubernetes service account for the EKS workload.

2. Configure a projected service account token whose audience is the Google workload identity provider.

3. Mount the external account configuration and make it available to the Google authentication library.

4. If the workload also calls AWS APIs, create a dedicated IAM role with only the required AWS permissions.

5. Connect the Kubernetes service account to that role using IRSA or EKS Pod Identity and confirm that AWS clients do not use the worker node role.

### In the Google identity project

1. Create a workload identity pool and an OpenID Connect provider for the EKS cluster.

2. Map the token subject, namespace, and Kubernetes service account attributes needed for policy decisions.

3. Add an attribute condition that restricts the accepted namespace and service account.

4. Create a dedicated bridge service account if the architecture needs one.

5. Grant Workload Identity User on that service account only to the specific external principal or principal set.

6. Enable the Security Token Service and IAM Service Account Credentials APIs required by the exchange.

### In the target Google Cloud project

1. Create a dedicated target service account for the environment.

2. Give it only the resource permissions needed for the setup operation.

3. Allow the bridge service account to create tokens for this target service account.

4. Keep unrelated projects and environments outside that trust relationship.

This separation makes ownership visible. EKS issues the workload identity claim. The identity project decides which external workloads may enter Google Cloud. The target project decides what an accepted workload may actually do.

## Why this design is important

The strongest benefit is that it replaces stored secrets with verifiable, temporary identity.

A service account key is a bearer credential. It can be copied and used from somewhere completely different from the system it was intended for. Federation asks the workload to prove its current Kubernetes identity every time it needs fresh Google credentials.

The design also improves least privilege. The Kubernetes service account identifies one workload. The workload identity provider accepts only that service account. The bridge identity can reach only selected target identities. The target service account can perform only selected resource operations. If the workload also needs AWS access, its separate AWS role can be restricted independently.

Revocation is more precise as well. Google access can be stopped by changing the projected token configuration, disabling the Google provider, removing the Workload Identity User binding, removing the Token Creator binding, or changing the target service account permissions. AWS access can be stopped separately by removing the EKS role association or changing the AWS role trust policy. There is no copied key that might remain usable somewhere unexpected.

The chain also produces better audit evidence. Google Cloud records token generation and API activity under the relevant principals and service accounts. When the workload also assumes an AWS role, AWS records the role session and AWS API activity. Together, these records make it easier to see how the workload entered each environment and what it did after entering.

For systems that create environments across accounts or clouds, these properties are not secondary details. Identity is part of the control plane. A deployment workflow with excessive credentials can affect every environment it is able to reach.

## The mistakes I would watch for

The first mistake is allowing the whole workload identity pool to impersonate the bridge service account. The binding should select the exact Kubernetes service account whenever possible.

The second is using the same projected service account token for every pod. The namespace, service account, audience, and provider condition should identify the intended workload rather than the whole cluster.

The third is accidentally using the EKS worker node role for AWS access. If the pod credential configuration is missing or the AWS SDK chooses an unexpected credential source, the workload can appear to work while using an identity with a much larger scope.

The fourth is granting Token Creator too broadly. Token Creator is powerful because it allows one principal to become another. The bridge service account should receive it only on the intended target service accounts, not across an entire organization.

The fifth is giving the bridge service account the target resource permissions directly. That collapses the boundary between federation and authorization. A separate target identity makes it easier for the target project owner to control and audit access.

The sixth is creating one shared target service account for many environments. A dedicated identity per environment or trust domain reduces the effect of a mistaken policy and makes audit records easier to interpret.

The seventh is building a long impersonation chain. Every additional hop adds another policy relationship, another token exchange, and another possible failure. The chain should be only as long as the ownership model requires.

## How I would debug a failed exchange

I would debug the chain from left to right rather than treating it as one authentication problem.

First, I would inspect the projected Kubernetes token claims. The issuer, subject, namespace, service account, expiration, and audience should match the EKS and Google provider configuration.

Second, I would verify that the external account configuration reads the correct token file and addresses the correct workload identity provider.

Third, I would verify the Google provider issuer, signing keys, audience, claim mapping, and attribute condition. A valid Kubernetes token can still be rejected when it was issued for a different audience or identity.

Fourth, I would separate federation from service account impersonation. If Security Token Service returns a federated token but `generateAccessToken` fails, the problem is likely the Workload Identity User binding or the IAM Service Account Credentials API.

Fifth, I would test the GCP to GCP hop separately. The bridge identity needs Token Creator on the target service account, while the target service account needs the resource permissions. These are different grants on different resources.

Finally, I would verify that the API client is using the final target token. A correct identity chain can still produce authorization errors if the client sends the bridge token to an API that expects the target identity.

If the design uses the alternative AWS provider, I would debug the AWS credential source separately. I would confirm the assumed role ARN, inspect how the Google library obtains the temporary credentials, and verify that the provider mapping handles the AWS STS assumed role format correctly.

## What I learned

The most useful mental model was to stop thinking of this as transferring credentials from AWS to Google Cloud.

Nothing permanent needs to be transferred. EKS makes a temporary claim about the workload through a signed Kubernetes token. Google verifies that claim and represents it as a federated principal. Google IAM then allows that principal to enter one service account and, where the ownership model requires it, move into a second service account with target specific permissions.

Each hop should be able to answer four questions:

1. Which identity is calling?

2. Why is it trusted?

3. Which identity may it impersonate next?

4. What can the final identity do?

When those answers are explicit, a complicated multicloud authentication path becomes a sequence of small, auditable trust decisions. That is what makes the design dependable enough for automation that operates across real cloud environments.
