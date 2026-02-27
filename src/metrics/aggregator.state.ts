export interface AggregatorStateData {
  lastRunAt: Date | null;
  lastWindowStart: Date | null;
  lastDurationMs: number | null;
  lastError: string | null;
}

class AggregatorStateSingleton {
  private state: AggregatorStateData = {
    lastRunAt: null,
    lastWindowStart: null,
    lastDurationMs: null,
    lastError: null,
  };

  public getState(): Readonly<AggregatorStateData> {
    return { ...this.state };
  }

  public update(update: Partial<AggregatorStateData>): void {
    this.state = { ...this.state, ...update };
  }
}

export const AggregatorState = new AggregatorStateSingleton();
