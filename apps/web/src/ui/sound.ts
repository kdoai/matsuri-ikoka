import { useEffect } from "react";
import { useAppStore } from "../state/react";
import type { SoundKind } from "../state/sound-cues";
import { soundCues } from "../state/sound-cues";

// 効果音は太鼓・拍子木・はんこの3種類だけ。音の素材は持たず、その場で合成する。

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") {
    return null;
  }
  context ??= new window.AudioContext();
  if (context.state === "suspended") {
    void context.resume();
  }
  return context;
}

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/** 低い音の高さを下げながら鳴らす（太鼓・はんこの胴の音） */
function thump(
  ctx: AudioContext,
  at: number,
  from: number,
  to: number,
  length: number,
  gain: number,
) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + length);
  amp.gain.setValueAtTime(gain, at);
  amp.gain.exponentialRampToValueAtTime(0.001, at + length);
  osc.connect(amp).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length);
}

/** 短い雑音を、帯域を絞って鳴らす（拍子木の木の音・はんこの紙の音） */
function click(ctx: AudioContext, at: number, frequency: number, length: number, gain: number) {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx, length);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = frequency;
  filter.Q.value = 8;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(gain, at);
  amp.gain.exponentialRampToValueAtTime(0.001, at + length);
  source.connect(filter).connect(amp).connect(ctx.destination);
  source.start(at);
}

export function playSound(kind: SoundKind): void {
  const ctx = audio();
  if (ctx === null) {
    return;
  }
  const now = ctx.currentTime + 0.01;
  switch (kind) {
    case "taiko":
      thump(ctx, now, 140, 55, 0.45, 0.7);
      click(ctx, now, 300, 0.08, 0.25);
      break;
    case "hyoshigi":
      click(ctx, now, 2400, 0.05, 0.6);
      click(ctx, now + 0.16, 2600, 0.05, 0.6);
      break;
    case "hanko":
      thump(ctx, now, 220, 90, 0.12, 0.5);
      click(ctx, now, 900, 0.06, 0.3);
      break;
  }
}

/** ストアの変化から効果音を鳴らす。音がオフのときは何もしない */
export function useSoundEffects(): void {
  const store = useAppStore();
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (!state.ui.soundOn) {
          return;
        }
        for (const kind of soundCues(previous, state)) {
          playSound(kind);
        }
      }),
    [store],
  );
}
