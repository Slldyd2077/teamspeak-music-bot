/** 20 ms frames: retain syllable tails without sending endless silent Opus packets. */
export class WebVoiceTransmitGate {
  private tailFrames = 0;
  accept(voiced: boolean): boolean {
    if (voiced) { this.tailFrames = 10; return true; }
    if (this.tailFrames > 0) { this.tailFrames--; return true; }
    return false;
  }
  reset(): void { this.tailFrames = 0; }
}
