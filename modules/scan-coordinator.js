// One serialized pipeline for chat and frontend sources. A running revision can
// never overwrite a newer revision. Failed revisions have bounded retries.
export class ScanCoordinator {
    constructor({ run, commit, onError = () => {}, onCancel = () => {} }) {
        Object.assign(this, { run, commit, onError, onCancel });
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
                if (!current()) { job.state = 'stale'; job.snapshot.onSettled?.(); continue; }
                job.state = 'running'; job.attempts++;
                try {
                    const result = await this.run(job.snapshot, current, job.controller.signal);
                    if (!current()) { job.state = job.cancelled ? 'cancelled' : 'stale'; continue; }
                    if (!result?.ok) {
                        const retryable = result?.retryable !== false;
                        const message = retryable ? '分析未完成，可在下一次检查时重试' : '回落配置已用完，可点击重试';
                        throw Object.assign(new Error(message), { retryable });
                    }
                    await this.commit(job.snapshot, result);
                    job.state = 'done';
                } catch (error) {
                    job.state = current() ? 'failed' : job.cancelled ? 'cancelled' : 'stale';
                    job.retryAt = error?.retryable === false ? Infinity : Date.now() + 10000 * job.attempts;
                    if (current()) this.onError(error, job.snapshot);
                } finally { job.snapshot.onSettled?.(); }
            }
        } finally { this.running = false; }
        // Retain a bounded set of completion/retry records, never queued work.
        for (const [key, job] of this.jobs) {
            if (this.jobs.size <= 200) break;
            if (['done', 'stale', 'failed'].includes(job.state)) this.jobs.delete(key);
        }
    }
    clear(matches = () => true) {
        for (const [key, job] of this.jobs) {
            if (!matches(job.snapshot)) continue;
            job.cancelled = true;
            job.controller?.abort();
            this.jobs.delete(key);
        }
    }
    cancelPending(snapshots = []) {
        for (const snapshot of snapshots) if (!this.jobs.has(snapshot.key))
            this.jobs.set(snapshot.key, { snapshot, attempts: 0, state: 'queued' });
        let count = 0;
        for (const job of this.jobs.values()) {
            if (!['running', 'queued', 'failed'].includes(job.state)) continue;
            job.cancelled = true; job.state = 'cancelled'; job.controller?.abort(); count++;
            this.onCancel(job.snapshot);
        }
        // Keep these records: polling must not restart work the user cancelled.
        return count;
    }
}
