/**
 * Annotation mutation transaction queue.
 *
 * Serial promise chain for optimistic updates:
 * 1. Builds optimistic doc from current state
 * 2. Applies immediately (optimistic update)
 * 3. Sends mutation to backend via bridge
 * 4. On success: replaces state with authoritative doc
 * 5. On failure: rolls back to pre-mutation doc
 *
 * Serialized per artifact — mutations cannot interleave.
 * Failed mutations do not block subsequent operations.
 */

import type {
  AnnotationDocument,
  AnnotationMutation,
} from "./annotation-types.ts";

export type AnnotationStoreHandle = {
  get doc(): AnnotationDocument | null;
  setDoc(v: AnnotationDocument | null): void;
  setError(v: string | null): void;
  setSaving(v: boolean): void;
};

type BuildOptimisticDoc = (current: AnnotationDocument) => AnnotationDocument;

type SendMutations = (
  project: string,
  slug: string,
  mutations: AnnotationMutation[],
) => Promise<AnnotationDocument>;

/**
 * Create a mutation queue bound to a project/slug pair.
 *
 * Accepts the store handle explicitly (not via import) to avoid
 * importing reactive runes from a .ts file.
 */
export function createMutationQueue(
  project: string,
  slug: string,
  sendMutations: SendMutations,
  store: AnnotationStoreHandle,
) {
  let queue = Promise.resolve();
  let pendingCount = 0;

  function enqueue(
    buildOptimisticDoc: BuildOptimisticDoc,
    mutations: AnnotationMutation[],
  ): Promise<void> {
    pendingCount++;
    store.setSaving(true);

    const run = async () => {
      const previousDoc = store.doc;
      if (!previousDoc) return;

      // Apply optimistic update immediately
      const optimisticDoc = buildOptimisticDoc(previousDoc);
      store.setDoc(optimisticDoc);
      store.setError(null);

      try {
        const authoritativeDoc = await sendMutations(project, slug, mutations);
        store.setDoc(authoritativeDoc);
      } catch (err) {
        // Roll back to pre-mutation doc.
        // Queue is serial, so no later operation has started yet.
        store.setDoc(previousDoc);
        store.setError(
          err instanceof Error ? err.message : "Failed to save annotation",
        );
      }
    };

    const operation = queue.catch(() => {}).then(run);
    // Ensure the queue continues even if this operation fails.
    const settled = operation.then(
      () => {},
      () => {},
    );
    queue = settled;

    return settled.finally(() => {
      pendingCount--;
      if (pendingCount === 0) {
        store.setSaving(false);
      }
    });
  }

  return { enqueue };
}
