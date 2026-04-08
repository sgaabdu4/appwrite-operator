import { randomUUID } from 'node:crypto';

export interface StoredResult {
    backendId: string;
    createdAt: string;
    id: string;
    text: string;
    toolName: string;
}

export class ResultStore {
    private static readonly MAX_SIZE = 50;
    private readonly results = new Map<string, StoredResult>();

    get(id: string): StoredResult | null {
        return this.results.get(id) ?? null;
    }

    list(): StoredResult[] {
        return [...this.results.values()];
    }

    save(backendId: string, toolName: string, text: string): StoredResult {
        const entry: StoredResult = {
            backendId,
            createdAt: new Date().toISOString(),
            id: randomUUID(),
            text,
            toolName,
        };

        this.results.set(entry.id, entry);

        if (this.results.size > ResultStore.MAX_SIZE) {
            const oldest = this.results.keys().next();
            if (oldest.value) {
                this.results.delete(oldest.value);
            }
        }

        return entry;
    }
}
