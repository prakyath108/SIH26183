// Audio context for beep sounds (lazy-initialized on first user interaction)
let audioCtx: AudioContext | null = null;

// Safari still prefixes the constructor; the prefixed form is absent from the DOM
// lib, so it is narrowed here rather than spread as `any` through the file.
type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctor) throw new Error("Web Audio unavailable");
    audioCtx = new Ctor();
  }
  return audioCtx;
}

/** Play a beep for high/critical priority case creation. */
export function playCasePriorityBeep(priority: string): void {
  const p = priority.toLowerCase();
  if (p !== "critical" && p !== "high") return;

  try {
    const ctx = getAudioContext();
    // Autoplay policy can leave the context suspended; resume() is async and the
    // beep is scheduled against currentTime regardless, so the promise is
    // deliberately not awaited — an unhandled rejection here would be noise.
    if (ctx.state === "suspended") void ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = p === "critical" ? 880 : 660; // A5 for critical, E5 for high

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);

    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.8);
  } catch {
    // Silently ignore audio errors (autoplay policy, etc.)
  }
}