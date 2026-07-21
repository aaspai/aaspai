/**
 * Kill switch — pause-all primitive.
 *
 * Per-loop and global. The scheduler checks the kill switch before
 * firing any wakeup. The global kill switch is stored in the DB
 * (audit_events with action = "kill_switch.toggled") so it survives
 * process restarts.
 */
import type { LoopConfigSource, LoopPattern } from "@aaspai/contracts/phase2";

export class KillSwitch {
  private readonly pausedLoops = new Set<string>();
  private globalPaused = false;
  private readonly callbacks = new Set<(state: KillSwitchState) => void>();

  pauseLoop(loopId: string, reason: string): void {
    this.pausedLoops.add(loopId);
    this.notify({ globalPaused: this.globalPaused, pausedLoops: [...this.pausedLoops], lastReason: reason });
  }

  resumeLoop(loopId: string): void {
    this.pausedLoops.delete(loopId);
    this.notify({ globalPaused: this.globalPaused, pausedLoops: [...this.pausedLoops] });
  }

  pauseGlobal(reason: string): void {
    this.globalPaused = true;
    this.notify({ globalPaused: true, pausedLoops: [...this.pausedLoops], lastReason: reason });
  }

  resumeGlobal(): void {
    this.globalPaused = false;
    this.notify({ globalPaused: false, pausedLoops: [...this.pausedLoops] });
  }

  isPaused(loopId: string): boolean {
    return this.globalPaused || this.pausedLoops.has(loopId);
  }

  isGlobalPaused(): boolean {
    return this.globalPaused;
  }

  state(): KillSwitchState {
    return { globalPaused: this.globalPaused, pausedLoops: [...this.pausedLoops] };
  }

  watch(callback: (state: KillSwitchState) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  private notify(state: KillSwitchState): void {
    for (const cb of this.callbacks) {
      try { cb(state); } catch { /* swallow */ }
    }
  }
}

export interface KillSwitchState {
  globalPaused: boolean;
  pausedLoops: string[];
  lastReason?: string;
}
