import Redis from 'ioredis';

export interface ClassificationJob {
  logId: string;
  promptContent: string;
  timestamp: string;
}

export class ClassificationQueue {
  constructor(private readonly redis: Redis, private readonly key: string) {}

  async enqueue(job: ClassificationJob): Promise<void> {
    await this.redis.lpush(this.key, JSON.stringify(job));
  }

  async dequeue(batchSize: number): Promise<ClassificationJob[]> {
    const jobs: ClassificationJob[] = [];
    for (let i = 0; i < batchSize; i++) {
      const item = await this.redis.rpop(this.key);
      if (!item) {
        break;
      }
      jobs.push(JSON.parse(item));
    }
    return jobs;
  }
}
