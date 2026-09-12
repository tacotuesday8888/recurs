import { PrivateJsonlStateStore, CompanyStateStoreError } from "./private-state-store.js";

export interface SessionMetadata {
  id: string;
  title: string | null;
  pinned: boolean;
  archived: boolean;
}

function parseMetadata(value: unknown): SessionMetadata {
  if (typeof value !== "object" || value === null) throw new Error("Invalid chat metadata");
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.pinned !== "boolean" || typeof item.archived !== "boolean" ||
    item.title !== null && (typeof item.title !== "string" || item.title.trim().length === 0 || [...item.title].length > 120 || /[\p{Cc}\p{Cf}]/u.test(item.title))) throw new Error("Chat titles must contain 1–120 printable characters");
  return { id: item.id, title: item.title as string | null, pinned: item.pinned, archived: item.archived };
}

/** Cosmetic metadata is separate from the execution log and its authority. */
export class FileSessionMetadataStore {
  readonly #store: PrivateJsonlStateStore<SessionMetadata>;
  constructor(directory: string) {
    this.#store = new PrivateJsonlStateStore(directory, { label: "Chat metadata", maximumBytes: 1024 * 1024, maximumRecords: 10000, parse: parseMetadata, idOf: (value) => value.id });
  }
  async list(): Promise<SessionMetadata[]> { return (await this.#store.list()).map((entry) => entry.state); }
  async update(id: string, patch: Partial<Omit<SessionMetadata, "id">>): Promise<SessionMetadata> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        let current;
        try { current = await this.#store.load(id); } catch (error) {
          if (!(error instanceof CompanyStateStoreError) || error.code !== "not_found") throw error;
        }
        const value = parseMetadata({ id, title: null, pinned: false, archived: false, ...current?.state, ...patch });
        if (current === undefined) await this.#store.create(value);
        else await this.#store.append(id, current.sequence, value);
        return value;
      } catch (error) {
        if (!(error instanceof CompanyStateStoreError) || !["conflict", "sequence_conflict"].includes(error.code) || attempt === 4) throw error;
      }
    }
    throw new Error("Chat metadata changed concurrently; retry the action");
  }
}
