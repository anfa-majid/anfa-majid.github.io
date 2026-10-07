---
title: Understanding NetApp entitlements through SMB and Active Directory
date: 2026-03-01
displayDate: March 2026
summary: How I learned to connect file ACLs, Windows identities, directory groups, and storage metadata to answer a deceptively simple question: who can access this file?
topics: Storage systems, SMB, Active Directory, LDAP, Entitlements
---

One of the areas I worked on in industry was extracting and understanding entitlement information from NetApp storage.

Before working on this, I understood permissions at a fairly high level. A file has an access control list, the list contains users or groups, and those entries grant permissions such as read or write.

That description is correct, but it is not enough to answer the question people usually care about:

> Which actual users can access this file, and why?

Working on enterprise storage taught me that the answer does not live in one system. It has to be assembled from storage metadata, Windows security information, directory identities, and group relationships.

## What I was working on

Part of my work involved building the entitlement data layer for NetApp storage. The purpose of that layer was to collect low level permission and identity information and turn it into a consistent model that downstream systems could use.

The data included file and directory ACLs, owners, security identifiers, local appliance groups, Active Directory identities, and group membership relationships.

The work was not simply about extracting an ACL and storing it. The useful result had to preserve enough evidence to explain how an individual user became entitled to a resource.

For example, a result should be able to express that a user can read a directory because the directory contains an inherited allow entry for an Active Directory group and the user belongs to that group through a nested membership path.

## What problem I was trying to solve

The simple question was:

> What permissions are attached to this file?

The more useful question was:

> Who ultimately receives access through those permissions?

Those questions are different.

An ACL might contain an entry like this:

```text
CORP\DataEngineering    Read
CORP\StorageAdmins      Full control
```

This tells me that two security principals appear in the ACL. It does not tell me which people belong to those groups. It also does not tell me whether membership is direct, inherited through another group, or no longer resolvable in the directory.

To produce an entitlement, I needed to connect the permission entry to the identity system and preserve the path between them.

## How the system actually works

I found it easier to understand the problem by separating it into storage, access, security, and identity concerns.

### The security descriptor and ACL

In the Windows security model, a file or directory can have a security descriptor. The descriptor contains information such as the owner and a discretionary access control list, commonly called a DACL.

The DACL is made up of access control entries, commonly called ACEs. An ACE normally contains several important pieces of information:

1. A security identifier that names the principal.
2. A type that indicates whether access is allowed or denied.
3. An access mask that represents rights such as reading data, writing data, deleting an object, or changing permissions.
4. Flags that describe inheritance and whether the entry applies to the current object, child files, child directories, or some combination of them.

This means that an ACL is not just a list of names and labels. It is an ordered set of rules with scope, inheritance, and identity semantics.

### Why SIDs matter

Windows ACLs commonly identify users and groups through security identifiers, or SIDs. A SID is a more reliable identity key than a display name because names can change, collide, or appear in different textual forms.

A storage ACL may therefore contain a value such as:

```text
S-1-5-21-...-1842
```

That value is useful to the operating system, but it is not yet useful to a person reviewing access. The SID has to be resolved to determine whether it represents a user, a group, a built in principal, a local storage identity, or an object that no longer exists.

I learned that unresolved SIDs should not be discarded. An unresolved entry is still part of the observed ACL. Removing it would make the collected representation incomplete and could hide stale or misconfigured access.

### Where SMB fits

SMB is the protocol commonly used for Windows style network file sharing. A client connects to an SMB share, authenticates as an identity, and performs operations against files and directories.

SMB provides the access path to the storage system and exposes Windows compatible security information. NetApp supplies the storage objects and serves them through the share. Active Directory supplies many of the identities referenced by their security descriptors.

Share permissions and file system permissions can both affect access. Being able to connect to a share does not mean a user can access every object below it. A permissive file ACL also does not help if the share layer is more restrictive.

The access result depends on the relevant layers together.

### Why Active Directory becomes necessary

Active Directory stores users, groups, and relationships between them. If an ACL contains an Active Directory group, the directory is needed to determine who belongs to that group.

Suppose an ACL grants read access to `DataEngineering` and the directory contains this relationship:

```text
DataEngineering
    Anfa
    PlatformTeam

PlatformTeam
    User A
    User B
```

Anfa is a direct member. User A and User B receive membership through the nested `PlatformTeam` group. All three may receive the access granted to `DataEngineering`, but the membership paths are different.

Keeping those paths matters. If somebody asks why User A appears in the entitlement result, the system should be able to show the sequence of groups that produced the answer.

### Where LDAP fits

LDAP is a protocol used to query directory services, including Active Directory. It provides a way to retrieve directory objects and attributes such as object SIDs, account names, object types, and group membership.

The storage side might tell me that a SID appears in an ACL. Directory queries help determine what that SID represents and how it relates to other identities.

This was initially unintuitive to me. I expected file permissions to be primarily a storage problem. In practice, enterprise access control is also an identity and directory problem.

### Why group expansion is a graph problem

Group membership is not always a flat list. Groups can contain other groups, which means entitlement expansion becomes graph traversal.

A correct traversal needs to account for repeated paths and cycles. It should track visited groups so that a circular membership relationship cannot cause endless recursion. It should also distinguish direct membership from transitive membership and preserve the path used to reach each user.

Large groups, unreadable directory objects, deleted identities, and cross domain relationships can all make the graph incomplete. An incomplete expansion should be reported as incomplete. It should not silently become a claim that no users have access.

### Inheritance and access evaluation

A child file or directory may inherit ACEs from a parent. It may also contain explicit entries of its own. Allow and deny entries, access masks, inheritance flags, and entry scope all affect the meaning of the ACL.

For that reason, I separate two kinds of output in my mental model:

1. **Observed permissions** preserve the security descriptor and ACL information collected from storage.
2. **Derived entitlements** describe the identities believed to receive access after resolution, membership expansion, and rule evaluation.

This separation makes the result auditable. If a derived entitlement looks wrong, I can trace it to the original ACE, the SID resolution result, the group membership path, and the evaluation decision.

## What I implemented

I think of the entitlement data layer as a pipeline with five responsibilities.

### 1. Collect storage security information

The first stage discovers the relevant storage objects and collects their security information. This includes paths, object types, owners, ACL entries, access masks, entry types, and inheritance details.

The raw values need to be preserved. Normalization should make data easier to compare, but it should not remove the original evidence.

### 2. Normalize permission records

Different sources can represent identities and permissions differently. The normalization stage converts those variations into a consistent internal model.

For an ACE, that model needs fields for the original principal, SID, allow or deny type, rights, inheritance scope, source object, and collection state.

### 3. Resolve identities

The next stage attempts to map each SID or named principal to an identity. The result might be an Active Directory user, an Active Directory group, a local NetApp group, a built in identity, or an unresolved principal.

Resolution status belongs in the data model. Unknown and not found are meaningful outcomes, not errors to hide.

### 4. Expand group membership

When a principal is a group, the pipeline traverses its membership graph. It records direct and transitive members, prevents cycles, and retains the path that connects each user to the ACL principal.

For example:

```text
File ACL
    DataEngineering
        PlatformTeam
            User A
```

The final entitlement for User A should retain that complete path.

### 5. Produce explainable entitlements

The last stage connects the normalized permission to the resolved identities and membership paths. The result answers both whether a user appears to have access and why.

A simplified record can be understood as:

```text
Resource
    Security descriptor
        ACE
            SID
                Directory group
                    Membership path
                        User
```

This lineage is what turns low level security data into an access model that another system can reason about.

## What confused me initially

The first confusing part was the difference between a permission and an entitlement.

A permission is an observed rule attached to an object. An entitlement is a derived statement about who ultimately receives access through one or more rules and identity relationships.

The second confusing part was that the storage system did not contain every answer. It contained the ACL, but group meaning lived in a directory service. The complete answer required data from systems with different identifiers, query models, and failure modes.

The third confusing part was that a missing answer did not mean no access. A SID might fail to resolve because directory data was unavailable. A group might fail to expand because a query was incomplete. Those cases represent uncertainty and must stay different from a confirmed absence of access.

## The mental model I use now

I now think about enterprise file access as a chain of connected layers:

```text
User identity
    Active Directory and group membership
        Authentication context
            SMB share
                NetApp file or directory
                    Security descriptor and ACL
                        Effective access
```

I also think about entitlement processing as a join between two views:

```text
Storage view                  Identity view

Files                         Users
Directories                   Groups
Owners                        SIDs
ACL entries                   Membership relationships
Inheritance                   Identity resolution

                Entitlement model
```

The entitlement model becomes useful only after those views are connected.

## What I learned

The main lesson was that effective access is not a property that can always be read from one object. It is a result derived from several systems at a particular moment in time.

Storage knows about objects and security descriptors. Active Directory knows about identities and group relationships. SMB supplies the access context. The entitlement layer connects those facts and preserves the explanation.

I also learned that explainability is a core systems requirement. A table that says User A can access a file is less useful than a result that can show the ACL entry, principal SID, resolved group, nested membership path, and inheritance source behind that decision.

This was one of the first industry problems that showed me how a filesystem question can become a distributed systems, identity, and data modeling problem.

## Things I want to remember

1. An ACL is evidence, not the complete effective access answer.
2. A permission and an entitlement are not the same thing.
3. SIDs should be preserved even when identity resolution fails.
4. Nested group membership is a graph and the membership path matters.
5. Observed permissions should remain separate from derived entitlements.
6. Unknown access caused by incomplete data is different from confirmed no access.
7. Every derived entitlement should retain enough lineage to explain why it exists.

The broader pattern applies beyond NetApp and SMB. Whenever authorization crosses storage, identity, and application boundaries, the real task is combining evidence from several systems and making the result understandable.
