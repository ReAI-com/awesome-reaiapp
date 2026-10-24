import type { VoiceRecordingSegment, VoiceRecordingSentence } from "@reai/app-sdk/v1";
import { isConfirmationUtterance, isPureFillerUtterance } from "./voice-utterance";

/** Deliberately narrow: ambiguous punctuation (?!, quotes, operators) is preserved. */
export function isEmptyContextText(text: string): boolean {
  return /^[\s.,，。、;；:：…]*$/u.test(text);
}

/** Display-only count, never a replacement for the stored transcript. */
export function contextCharacterCount(text: string): number {
  return Array.from(text).filter((char) => !/[\p{P}\p{Z}\s]/u.test(char)).length;
}

export function hasUnfinishedContextStatus(item: VoiceRecordingSegment): boolean {
  const status = item.transcriptStatus !== undefined
    ? item.transcriptStatus
    : (item as VoiceRecordingSegment & { transcriptionStatus?: string }).transcriptionStatus;
  return status != null && status !== "complete";
}

export function isEmptyContextRecording(item: VoiceRecordingSegment): boolean {
  return !hasUnfinishedContextStatus(item)
    && typeof item.transcriptText === "string"
    && isEmptyContextText(item.transcriptText)
    && (item.sentences ?? []).every((sentence) => isEmptyContextText(sentence.text));
}

export interface ContextDisplayBlock {
  empty: boolean;
  indices: number[];
  sentences: VoiceRecordingSentence[];
  startMs?: number;
  endMs?: number;
}

function validWallTime(value: number): boolean {
  return Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime());
}
function sameDay(start: number, end: number): boolean {
  return new Date(start).toDateString() === new Date(end).toDateString();
}

/** Only existing, exactly touching completed sentence intervals can join. No gap filling. */
export function projectContextSentences(item: VoiceRecordingSegment): ContextDisplayBlock[] {
  const sentences = item.sentences ?? [];
  const valid = (sentence: VoiceRecordingSentence) => validWallTime(item.wallStartMs)
    && Number.isSafeInteger(sentence.startMs) && Number.isSafeInteger(sentence.endMs)
    && sentence.endMs > sentence.startMs
    && validWallTime(item.wallStartMs + sentence.startMs)
    && validWallTime(item.wallStartMs + sentence.endMs);
  const blocks: ContextDisplayBlock[] = [];
  sentences.forEach((sentence, index) => {
    const empty = !hasUnfinishedContextStatus(item) && isEmptyContextText(sentence.text);
    const startMs = valid(sentence) ? item.wallStartMs + sentence.startMs : undefined;
    const endMs = valid(sentence) ? item.wallStartMs + sentence.endMs : undefined;
    const previous = blocks.at(-1);
    const intersectsOther = previous?.startMs !== undefined && endMs !== undefined
      && sentences.some((other, otherIndex) => !previous.indices.includes(otherIndex) && otherIndex !== index
        && (!valid(other) || (item.wallStartMs + other.startMs < endMs
          && item.wallStartMs + other.endMs > previous.startMs!)));
    if (empty && previous?.empty && startMs !== undefined && endMs !== undefined
      && previous.startMs !== undefined && previous.endMs === startMs
      && sameDay(previous.startMs, endMs) && !intersectsOther) {
      previous.indices.push(index);
      previous.sentences.push(sentence);
      previous.endMs = endMs;
    } else {
      blocks.push({ empty, indices: [index], sentences: [sentence], startMs, endMs });
    }
  });
  return blocks;
}

export interface ContextUtteranceBlock extends ContextDisplayBlock {
  text: string;
  filler: boolean;
}

/** Display joining only: never infer speaker identity or modify Host-owned fragments. */
export function projectContextUtterances(item: VoiceRecordingSegment): ContextUtteranceBlock[] {
  const unfinished = hasUnfinishedContextStatus(item);
  const blocks: ContextDisplayBlock[] = [];
  for (const block of projectContextSentences(item)) {
    const previous = blocks.at(-1);
    const gap = block.startMs !== undefined && previous?.endMs !== undefined ? block.startMs - previous.endMs : -1;
    // Every block contains a contiguous slice of the unchanged source sequence.
    // Range membership avoids repeatedly searching an ever-growing indices array.
    const firstIndex = previous?.indices[0];
    const lastIndex = block.indices.at(-1)!;
    const intersectsOther = previous?.startMs !== undefined && block.endMs !== undefined
      && (item.sentences ?? []).some((sentence, index) => (index < firstIndex! || index > lastIndex)
        && Number.isSafeInteger(sentence.startMs) && Number.isSafeInteger(sentence.endMs)
        && item.wallStartMs + sentence.startMs < block.endMs!
        && item.wallStartMs + sentence.endMs > previous.startMs!);
    if (!unfinished && !block.empty && previous && !previous.empty && gap >= 0 && gap <= 1500
      && previous.startMs !== undefined && block.endMs !== undefined
      && sameDay(previous.startMs, block.endMs) && !intersectsOther) {
      previous.indices.push(...block.indices);
      previous.sentences.push(...block.sentences);
      previous.endMs = block.endMs;
    } else blocks.push({ ...block, indices: [...block.indices], sentences: [...block.sentences] });
  }
  return blocks.map(block => ({
    ...block,
    text: unfinished ? block.sentences.map(s => s.text).join("\n") : contextUtteranceText(block.sentences.map(s => s.text)),
    filler: !unfinished && !block.empty && isContextFiller(block.sentences.map(s => s.text).join("\n")),
  }));
}

export function isContextFiller(text: string): boolean {
  return isPureFillerUtterance(text) && !isConfirmationUtterance(text);
}

/** Collapse runs of filler fragments, preserving a single filler inside useful speech. */
export function contextUtteranceText(fragments: readonly string[]): string {
  const texts: string[] = [];
  for (let index = 0; index < fragments.length; index++) {
    const text = fragments[index]!.trim();
    if (isPureFillerUtterance(text)) {
      let end = index + 1;
      while (end < fragments.length && isPureFillerUtterance(fragments[end]!)) end++;
      texts.push(text + (end > index + 1 ? "…" : ""));
      index = end - 1;
    } else texts.push(text);
  }
  return texts.reduce((joined, text) => joined + (/[A-Za-z0-9][.,!?;:…'"）)\]]*$/u.test(joined)
    && /^[A-Za-z0-9("']/u.test(text) ? " " : "") + text, "");
}

/** Main UI stops at seconds; expanded audit retains exact milliseconds. */
export function contextTime(value: number, precise = false): string {
  if (!validWallTime(value)) return "";
  const date = new Date(value);
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  return clock + (precise ? `.${String(date.getMilliseconds()).padStart(3, "0")}` : "");
}

/**
 * Timeline grouping: consecutive completed empty recordings form one run.
 * Pending or speech-bearing segments always stand alone, so nothing waiting
 * for transcription is hidden inside a "silence" row.
 */
export function contextSegmentRuns(items: readonly VoiceRecordingSegment[]): VoiceRecordingSegment[][] {
  const runs: VoiceRecordingSegment[][] = [];
  let previousEmpty = false;
  for (const item of items) {
    const empty = isEmptyContextRecording(item);
    if (empty && previousEmpty) runs.at(-1)!.push(item);
    else runs.push([item]);
    previousEmpty = empty;
  }
  return runs;
}
