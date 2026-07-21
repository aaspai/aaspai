/**
 * In-memory knowledge index. The foundation slice uses a simple
 * Map-based index. Phase 4 swaps in SQLite FTS5 / Postgres pg_trgm /
 * vector search without changing the public surface.
 */
import type { KnowledgeConcept } from "@aaspai/contracts/phase2";

export class KnowledgeIndexer {
  private readonly byId = new Map<string, KnowledgeConcept>();
  private readonly byTag = new Map<string, Set<string>>();
  private readonly byConceptType = new Map<string, Set<string>>();

  add(concept: KnowledgeConcept): void {
    this.byId.set(concept.id, concept);
    for (const tag of concept.tags) {
      const set = this.byTag.get(tag) ?? new Set();
      set.add(concept.id);
      this.byTag.set(tag, set);
    }
    const typeSet = this.byConceptType.get(concept.type) ?? new Set();
    typeSet.add(concept.id);
    this.byConceptType.set(concept.type, typeSet);
  }

  remove(id: string): void {
    const concept = this.byId.get(id);
    if (!concept) return;
    this.byId.delete(id);
    for (const tag of concept.tags) this.byTag.get(tag)?.delete(id);
    this.byConceptType.get(concept.type)?.delete(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): KnowledgeConcept | undefined {
    return this.byId.get(id);
  }

  byIds(ids: readonly string[]): KnowledgeConcept[] {
    const out: KnowledgeConcept[] = [];
    for (const id of ids) {
      const c = this.byId.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  withTag(tag: string): readonly string[] {
    return [...(this.byTag.get(tag) ?? [])];
  }

  withType(type: string): readonly string[] {
    return [...(this.byConceptType.get(type) ?? [])];
  }

  all(): readonly KnowledgeConcept[] {
    return [...this.byId.values()];
  }

  size(): number {
    return this.byId.size;
  }
}
