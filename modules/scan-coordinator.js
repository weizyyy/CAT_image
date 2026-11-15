// One serialized pipeline for chat and frontend sources. A running revision can
// never overwrite a newer revision. Failed revisions have bounded retries.
export class ScanCoordinator {
    constructor({ run, commit, onError = () => {} }) {
        Object.assign(this, { run, commit, onError });
        this.jobs = new Map();
        this.running = false;
    }
    submit(snapshot) {
        for (const [key, job] of this.jobs) {
            if (job.snapshot.owner === snapshot.owner && key !== snapshot.key) {
                job.cancelled = true;
                job.controller?.abort();
                this.jobs.delete(key);
            }
        }
        let job = this.jobs.get(snapshot.key);
        if (job && job.state === 'stale') { this.jobs.delete(snapshot.key); job = null; }
        if (job && (job.state !== 'failed' || job.attempts >= 3 || Date.now() < job.retryAt)) return job;
        if (!job) job = { snapshot, attempts: 0, controller: new AbortController() };
        job.state = 'queued';
        this.jobs.set(snapshot.key, job);
        void this.drain();
        return job;
    }
    async drain() {
        if (this.running) return;
        this.running = true;
        try {
            for (;;) {
                const job = Array.from(this.jobs.values()).find(j => j.state === 'queued');
                if (!job) break;
                const current = () => !job.cancelled && job.snapshot.isCurrent();
                if (!current()) { job.state = 'stale'; continue; }
                job.state = 'running'; job.attempts++;
                try {
                    const result = await this.run(job.snapshot, current, job.controller.signal);
                    if (!current()) { job.state = 'stale'; continue; }
                    if (!result?.ok) throw new Error('分析未完成，可在下一次检查时重试');
                    await this.commit(job.snapshot, result);
                    job.state = 'done';
                } catch (error) {
                    job.state = current() ? 'failed' : 'stale';
                    job.retryAt = Date.now() + 10000 * job.attempts;
                    if (current()) this.onError(error, job.snapshot);
                }
            }
        } finally { this.running = false; }
        // Retain a bounded set of completion/retry records, never queued work.
        for (const [key, job] of this.jobs) {
            if (this.jobs.size <= 200) break;
            if (['done', 'stale', 'failed'].includes(job.state)) this.jobs.delete(key);
        }
    }
    clear() {
        for (const job of this.jobs.values()) { job.cancelled = true; job.controller?.abort(); }
        this.jobs.clear();
    }
}
