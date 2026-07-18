import {
  defineEdge,
  defineGraph,
  defineNode,
  implies,
  inverseOf,
} from "@nicia-ai/typegraph";
import { z } from "zod";

/**
 * Zanzibar-lite authorization as a graph, one graph per workspace.
 *
 * Two node partitions never share an edge kind except through a relation
 * grant: subjects (`User`, `Group`) and resources (`Folder`, `Doc`). That
 * separation is what lets an authorization check be a single reachability
 * query — see {@link ./check}.
 */

const subjectSchema = z.object({ name: z.string() });
const resourceSchema = z.object({ name: z.string() });

export const User = defineNode("User", { schema: subjectSchema });
export const Group = defineNode("Group", { schema: subjectSchema });
export const Folder = defineNode("Folder", { schema: resourceSchema });
export const Doc = defineNode("Doc", { schema: resourceSchema });

const subjects = [User, Group] as const;
const resources = [Folder, Doc] as const;

// Edges are defined unconstrained (schema only) so they can feed the
// ontology relations below; their domain/range live in the graph's `edges`
// registration, which is what types the store's collections.

/** `User`/`Group` → `Group`: direct or nested group membership. */
export const memberOf = defineEdge("memberOf", { schema: z.object({}) });

/**
 * Declared inverse of {@link memberOf} — "the members of this group". No
 * `hasMember` edge is ever stored; traversing it derives from stored
 * `memberOf` edges read backwards (see the `/members` endpoint).
 */
export const hasMember = defineEdge("hasMember", { schema: z.object({}) });

/** `Folder` → `Folder`/`Doc`: a folder contains its children. */
export const parentOf = defineEdge("parentOf", { schema: z.object({}) });

export const owner = defineEdge("owner", { schema: z.object({}) });
export const editor = defineEdge("editor", { schema: z.object({}) });
export const viewer = defineEdge("viewer", { schema: z.object({}) });

export const authzGraph = defineGraph({
  id: "authz",
  nodes: {
    User: { type: User },
    Group: { type: Group },
    Folder: { type: Folder },
    Doc: { type: Doc },
  },
  edges: {
    memberOf: { type: memberOf, from: subjects, to: [Group] },
    hasMember: { type: hasMember, from: [Group], to: subjects },
    parentOf: { type: parentOf, from: [Folder], to: resources },
    owner: { type: owner, from: subjects, to: resources },
    editor: { type: editor, from: subjects, to: resources },
    viewer: { type: viewer, from: subjects, to: resources },
  },
  ontology: [
    // owner ⇒ editor ⇒ viewer: a stronger grant satisfies a weaker check.
    implies(owner, editor),
    implies(editor, viewer),
    // Read `memberOf` backwards without storing the reverse edges.
    inverseOf(memberOf, hasMember),
  ],
});

/** Relation kinds, strongest first — the ontology order of `implies`. */
export const RELATION_KINDS = ["owner", "editor", "viewer"] as const;
export type Relation = (typeof RELATION_KINDS)[number];

export const MEMBER_OF = "memberOf";
export const HAS_MEMBER = "hasMember";
export const PARENT_OF = "parentOf";

export const SUBJECT_KINDS = ["User", "Group"] as const;
export const RESOURCE_KINDS = ["Folder", "Doc"] as const;

/** Node kind for each deterministic id prefix, e.g. `user:alice` → `User`. */
export const KIND_BY_PREFIX: Readonly<Record<string, string>> = {
  user: "User",
  group: "Group",
  folder: "Folder",
  doc: "Doc",
};

export function isRelation(value: string): value is Relation {
  return (RELATION_KINDS as readonly string[]).includes(value);
}

export function isSubjectKind(kind: string): boolean {
  return (SUBJECT_KINDS as readonly string[]).includes(kind);
}

export function isResourceKind(kind: string): boolean {
  return (RESOURCE_KINDS as readonly string[]).includes(kind);
}
