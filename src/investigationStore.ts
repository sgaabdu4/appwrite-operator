import { randomUUID } from 'node:crypto';

import type { InvestigationRecord } from './types.js';

export class InvestigationStore {
    private static readonly MAX_SIZE = 100;
    private readonly investigations = new Map<string, InvestigationRecord>();

    get(id: string): InvestigationRecord | null {
        return this.investigations.get(id) ?? null;
    }

    list(): InvestigationRecord[] {
        return [...this.investigations.values()].sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt),
        );
    }

    save(goal: string, record: Omit<InvestigationRecord, 'createdAt' | 'goal' | 'id'>): InvestigationRecord {
        const investigation: InvestigationRecord = {
            createdAt: new Date().toISOString(),
            goal,
            id: randomUUID(),
            plan: record.plan,
            results: record.results,
        };

        this.investigations.set(investigation.id, investigation);

        if (this.investigations.size > InvestigationStore.MAX_SIZE) {
            const oldest = this.list().at(-1);
            if (oldest) {
                this.investigations.delete(oldest.id);
            }
        }

        return investigation;
    }
}
